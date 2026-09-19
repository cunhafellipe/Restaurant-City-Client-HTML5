import Phaser from 'phaser';
import {
  defaultWallAttachmentRotation,
  projectTile,
  rotateFootprint,
  screenToTileIndex,
  validateHistoricalTileStack,
  validateStructuralPlacement,
  type Footprint,
  type PlacementShape,
  type RoomDimensions,
  type TilePoint,
} from '../../core/restaurantGrid';
import { computeHistoricalCurHeights } from '../../core/restaurantStacking';
import {
  buildRestaurantItemCatalog,
  type RestaurantItemDefinition,
} from '../../content/items';
import {
  buildRestaurantItemVisualIndex,
  frameForRestaurantItemRotation,
  historicalRoomItemFrameOffset,
  isSystemOnlyRestaurantItem,
  resolveRestaurantItemVisual,
  type RestaurantItemVisual,
  type RestaurantItemVisualIndex,
} from '../../content/itemVisual';
import {
  recoveredDoorMaskRaster,
  recoveredWallFloorFrameOffset,
} from '../../content/recoveredWallFloorGeometry';
import {
  recoveredWallpaperFrame,
  recoveredWallpaperFrameOffset,
  recoveredWallpaperGeometry,
} from '../../content/recoveredWallpaperGeometry';
import {
  loadGeneratedItemDatabase,
  loadRuntimeManifest,
} from '../../content/runtime';
import {
  createPlacementMutationId,
  createRemoveMutationId,
  createTransformMutationId,
  createWallpaperMutationId,
  RestaurantAuthorityError,
  type AuthoritativeFloorTile,
  type AuthoritativeInventoryAvailability,
  type AuthoritativePlacedItem,
  type AuthoritativeWallpaper,
  type RestaurantAuthority,
  type RestaurantLayout,
} from '../../net/restaurantAuthority';
import {
  gameUiBridge,
  type GameUiState,
} from '../../shell/gameBridge';
import { requireRestaurantAuthority } from '../services';

/**
 * GameWorld.LEVEL_THRESHOLDS[0] in the recovered client is 8x8.
 * Outside-area dimensions are deliberately zero here until their historical
 * progression/config source is ported; we do not invent outside geometry.
 */
const INITIAL_ROOM: RoomDimensions = {
  insideX: 8,
  insideY: 8,
  outsideX: 0,
  outsideY: 0,
};

const ORIGIN = { x: 380, y: 105 };
const SIMPLE_WINDOW_ITEM_ID = 3000001;
const SIMPLE_DOOR_ITEM_ID = 3010000;
const DEFAULT_WALL_ITEM_ID = 3090000;
const DEFAULT_WALL_CORNER_ITEM_ID = 3090001;

type EditorPlacementValidation =
  | ReturnType<typeof validateStructuralPlacement>
  | {
      readonly ok: false;
      readonly reason:
        | 'occupied'
        | 'unavailable'
        | 'authority-desynced'
        | 'wall-required';
    };

export class RestaurantEditorScene extends Phaser.Scene {
  private floorGraphics!: Phaser.GameObjects.Graphics;
  private committedGraphics!: Phaser.GameObjects.Graphics;
  private previewGraphics!: Phaser.GameObjects.Graphics;
  private committedSprites: Phaser.GameObjects.Sprite[] = [];
  private floorSprites: Phaser.GameObjects.Sprite[] = [];
  private wallSprites: Phaser.GameObjects.Sprite[] = [];
  private wallCutoutTextures: Phaser.GameObjects.RenderTexture[] = [];
  private wallCutoutSources: Array<
    Phaser.GameObjects.Sprite | Phaser.GameObjects.RenderTexture
  > = [];
  private wallpaperWallLayers = new Map<
    string,
    {
      readonly texture: Phaser.GameObjects.RenderTexture;
      readonly sourceWall: Phaser.GameObjects.Sprite;
      readonly wallpaper: AuthoritativeWallpaper;
      readonly tile: TilePoint;
    }
  >();
  private doorProbeWall: Phaser.GameObjects.RenderTexture | null = null;
  private doorProbeDoor: Phaser.GameObjects.Sprite | null = null;
  private previewSprite: Phaser.GameObjects.Sprite | null = null;
  private wallpaperPreviewSprites: Phaser.GameObjects.Sprite[] = [];
  private visualIndex: RestaurantItemVisualIndex | null = null;
  private authority!: RestaurantAuthority;
  private unsubscribeCommands: (() => void) | null = null;

  private candidates: readonly RestaurantItemDefinition[] = [];
  private catalogById = new Map<number, RestaurantItemDefinition>();
  private inventoryByItemId = new Map<
    number,
    AuthoritativeInventoryAvailability
  >();
  private authoritativeItems: readonly AuthoritativePlacedItem[] = [];
  private authoritativeFloorTiles: readonly AuthoritativeFloorTile[] = [];
  private authoritativeWallpapers: readonly AuthoritativeWallpaper[] = [];

  private room: RoomDimensions = INITIAL_ROOM;
  private selectedIndex = 0;
  private rotation = 0;
  private hoverTile: TilePoint | null = null;
  private authorityLoaded = false;
  private authoritySynchronized = false;
  private placementInFlight = false;
  private selectedPlacedInstanceId: number | null = null;
  private selectedWallpaperRotation: 0 | 1 | null = null;

  constructor() {
    super('RestaurantEditor');
  }

  preload(): void {
    this.load.multiatlas(
      'indoor_asset',
      'assets/generated/atlases/indoor_asset.json',
    );
  }

  create(): void {
    this.cameras.main.setBackgroundColor(0x1c2b33);
    this.authority = requireRestaurantAuthority(this);

    this.floorGraphics = this.add.graphics();
    this.committedGraphics = this.add.graphics();
    this.previewGraphics = this.add.graphics();

    gameUiBridge.publish({
      phase: 'loading-content',
      status: 'Loading generated Restaurant City data…',
    });

    this.drawFloor();
    this.bindInput();
    void this.initializeEditor();
  }

  private drawFloor(): void {
    this.floorGraphics.clear();
    for (const sprite of this.floorSprites) sprite.destroy();
    this.floorSprites = [];
    this.floorGraphics.lineStyle(1, 0x6f8b96, 0.75);

    for (const tile of this.authoritativeFloorTiles) {
      const definition = this.catalogById.get(tile.itemId);
      if (!definition || !this.isAuthoritativeFloorTile(definition)) {
        throw new Error(
          `Authoritative floor references unsupported item #${tile.itemId}`,
        );
      }
      const visual = this.itemVisual(definition);
      if (!visual) {
        throw new Error(
          `Authoritative floor item #${tile.itemId} has no runtime atlas visual`,
        );
      }

      const sprite = this.createItemSprite(
        definition,
        visual,
        0,
        { x: tile.tileX, y: tile.tileY },
        1,
      );
      sprite.setDepth(-10_000 + tile.tileY * 20 + tile.tileX);
      this.floorSprites.push(sprite);
    }

    for (let x = 0; x < this.room.insideX; x += 1) {
      for (let y = 0; y < this.room.insideY; y += 1) {
        this.drawTileFootprint(
          this.floorGraphics,
          { x, y },
          { sizeX: 1, sizeY: 1 },
          false,
        );
      }
    }
  }

  private bindInput(): void {
    this.input.on(
      Phaser.Input.Events.POINTER_MOVE,
      (pointer: Phaser.Input.Pointer) => {
        this.hoverTile = screenToTileIndex({
          x: pointer.x - ORIGIN.x,
          y: pointer.y - ORIGIN.y,
        });
        this.drawPreview();
      },
    );

    const rotate = () => {
      if (this.placementInFlight || this.selectedWallpaperRotation !== null) return;
      const item = this.currentDefinition();
      if (item && this.isAuthoritativeWallpaper(item)) {
        this.publishUi(
          'Wallpaper orientation is derived from the wall under the pointer.',
          this.currentValidation(),
        );
        return;
      }
      const maxRotations = this.currentVisual()?.frames.length ?? 1;
      this.rotation = (this.rotation + 1) % maxRotations;
      this.refreshSelectedItem();
      this.drawPreview();
    };

    this.input.keyboard?.on('keydown-R', rotate);
    this.input.keyboard?.on('keydown-LEFT', () => this.selectRelative(-1));
    this.input.keyboard?.on('keydown-RIGHT', () => this.selectRelative(1));
    this.input.keyboard?.on('keydown-ESC', () => this.cancelSelectedEdit());
    this.input.keyboard?.on('keydown-DELETE', () => {
      void this.removeSelectedAuthorityState();
    });
    this.input.keyboard?.on('keydown-BACKSPACE', () => {
      void this.removeSelectedAuthorityState();
    });

    this.unsubscribeCommands = gameUiBridge.subscribeCommands((command) => {
      if (command === 'previous-item') this.selectRelative(-1);
      else if (command === 'next-item') this.selectRelative(1);
      else if (command === 'rotate-item') rotate();
      else if (command === 'remove-selected') {
        void this.removeSelectedAuthorityState();
      } else if (command === 'cancel-edit') {
        this.cancelSelectedEdit();
      }
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.unsubscribeCommands?.();
      this.unsubscribeCommands = null;
    });

    this.input.on(Phaser.Input.Events.POINTER_DOWN, () => {
      void this.commitCurrentMutation();
    });
  }

  private async initializeEditor(): Promise<void> {
    try {
      const manifest = await loadRuntimeManifest();
      const database = await loadGeneratedItemDatabase(manifest, 'restaurant');
      const catalog = buildRestaurantItemCatalog(database);

      this.catalogById = new Map(catalog.map((item) => [item.id, item]));
      this.visualIndex = buildRestaurantItemVisualIndex([
        {
          atlasId: 'indoor_asset',
          frameNames: this.requireAtlasFrameNames('indoor_asset'),
        },
      ]);
      this.candidates = catalog.filter(
        (item) =>
          this.isOrdinaryPlaceable(item) || this.isAuthoritativeWallpaper(item),
      );

      for (const item of this.candidates) {
        if (!this.itemVisual(item)) {
          throw new Error(
            `Player-placeable Restaurant City item #${item.id} (${item.name}) has no exact runtime atlas visual`,
          );
        }
      }

      if (this.candidates.length === 0) {
        throw new Error(
          'restaurant ItemDatabase contains no authoritative editor item with proven geometry',
        );
      }

      gameUiBridge.publish({
        phase: 'loading-authority',
        baseline: manifest.baseline,
        status: 'Loading authoritative ANEWON restaurant state…',
        corpus: {
          restaurantRecords: catalog.length,
          explicitFootprints: this.candidates.length,
        },
      });

      const layout = await this.authority.loadRestaurant();
      this.applyAuthoritativeLayout(layout);

      const firstAvailable = this.candidates.findIndex(
        (item) => this.availableFor(item.id) > 0,
      );
      this.selectedIndex = firstAvailable >= 0 ? firstAvailable : 0;
      this.rotation = 0;

      gameUiBridge.publish({
        phase: 'editing',
        baseline: manifest.baseline,
        status:
          `Loaded baseline ${manifest.baseline}, ${layout.items.length} persisted object(s), ${layout.floorTiles.length} floor tile(s), and ${layout.wallpapers.length} wallpaper slot(s).`,
        selectedItem: this.selectedItemUi(),
        corpus: {
          restaurantRecords: catalog.length,
          explicitFootprints: this.candidates.length,
        },
      });
      this.drawPreview(false);
    } catch (error) {
      this.publishInitializationError(error);
    }
  }

  private applyAuthoritativeLayout(layout: RestaurantLayout): void {
    if (layout.room.insideX === 0 || layout.room.insideY === 0) {
      throw new Error('Authoritative restaurant room has invalid zero dimensions');
    }

    for (const tile of layout.floorTiles) {
      const definition = this.catalogById.get(tile.itemId);
      if (!definition || !this.isAuthoritativeFloorTile(definition)) {
        throw new Error(
          `Authoritative floor references unsupported item #${tile.itemId}`,
        );
      }
      const visual = this.itemVisual(definition);
      if (!visual || visual.frames.length !== 1) {
        throw new Error(
          `Authoritative floor item #${tile.itemId} has invalid visual frame contract`,
        );
      }
    }

    const seenWallpaperRotations = new Set<number>();
    for (const wallpaper of layout.wallpapers) {
      if (seenWallpaperRotations.has(wallpaper.rotation)) {
        throw new Error('Authoritative layout has duplicate wallpaper orientation');
      }
      seenWallpaperRotations.add(wallpaper.rotation);

      const definition = this.catalogById.get(wallpaper.itemId);
      if (!definition || !this.isAuthoritativeWallpaper(definition)) {
        throw new Error(
          `Authoritative wallpaper references unsupported item #${wallpaper.itemId}`,
        );
      }
      const visual = this.itemVisual(definition);
      const recovered = recoveredWallpaperFrame(
        definition.id,
        definition.className,
        wallpaper.rotation,
      );
      if (
        !visual ||
        visual.frames.length !== 2 ||
        !recovered ||
        !visual.frames.includes(recovered.frame)
      ) {
        throw new Error(
          `Authoritative wallpaper #${wallpaper.itemId} has invalid visual contract`,
        );
      }
    }

    for (const placed of layout.items) {
      const definition = this.catalogById.get(placed.itemId);
      if (
        !definition ||
        (!this.isOrdinaryPlaceable(definition) &&
          !this.isAuthoritativeWallAttachment(definition))
      ) {
        throw new Error(
          `Authoritative layout references unsupported item #${placed.itemId}`,
        );
      }
      const visual = this.itemVisual(definition);
      if (!visual || placed.rotation >= visual.frames.length) {
        throw new Error(
          `Authoritative layout has invalid visual/rotation for item #${placed.itemId}`,
        );
      }
    }

    this.room = {
      insideX: layout.room.insideX,
      insideY: layout.room.insideY,
      outsideX: layout.room.outsideX,
      outsideY: layout.room.outsideY,
    };
    this.authoritativeItems = [...layout.items];
    this.authoritativeFloorTiles = [...layout.floorTiles];
    this.authoritativeWallpapers = [...layout.wallpapers];
    this.inventoryByItemId = new Map(
      layout.inventory.map((entry) => [entry.itemId, entry]),
    );
    this.authorityLoaded = true;
    this.authoritySynchronized = true;

    if (this.selectedPlacedInstanceId !== null) {
      const selected = this.selectedPlacedItem();
      if (selected) {
        this.rotation = selected.rotation;
      } else {
        this.selectedPlacedInstanceId = null;
        this.rotation = 0;
      }
    }
    if (
      this.selectedWallpaperRotation !== null &&
      !this.authoritativeWallpapers.some(
        (wallpaper) => wallpaper.rotation === this.selectedWallpaperRotation,
      )
    ) {
      this.selectedWallpaperRotation = null;
    }

    this.drawFloor();
    this.drawDefaultWalls();
    this.drawCommittedPlacements();
    this.refreshSelectedItem();
  }

  private isAuthoritativeFloorTile(
    item: RestaurantItemDefinition,
  ): boolean {
    const footprint = item.placementFootprint;
    return (
      footprint?.sizeX === 1 &&
      footprint.sizeY === 1 &&
      !isSystemOnlyRestaurantItem(item) &&
      item.placement.floorTileItem === true &&
      !item.placement.wallItem &&
      !item.placement.wallDecorationItem &&
      !item.placement.wallpaperItem &&
      !item.placement.outdoor
    );
  }

  private isAuthoritativeWallpaper(
    item: RestaurantItemDefinition,
  ): boolean {
    const geometry = recoveredWallpaperGeometry(item.id, item.className);
    return (
      geometry !== null &&
      geometry.frames.length === 2 &&
      !isSystemOnlyRestaurantItem(item) &&
      item.placement.wallpaperItem === true &&
      !item.placement.wallItem &&
      !item.placement.wallDecorationItem &&
      !item.placement.floorTileItem &&
      !item.placement.outdoor
    );
  }

  private isAuthoritativeWallAttachment(
    item: RestaurantItemDefinition,
  ): boolean {
    const footprint = item.placementFootprint;
    return (
      (item.id === SIMPLE_WINDOW_ITEM_ID || item.id === SIMPLE_DOOR_ITEM_ID) &&
      footprint?.sizeX === 1 &&
      footprint.sizeY === 1 &&
      item.placement.wallDecorationItem === true &&
      !item.placement.wallItem &&
      !item.placement.wallpaperItem &&
      !item.placement.floorTileItem &&
      !item.placement.outdoor
    );
  }

  private isOrdinaryPlaceable(item: RestaurantItemDefinition): boolean {
    const footprint = item.placementFootprint;
    return (
      footprint !== null &&
      footprint.sizeX > 0 &&
      footprint.sizeY > 0 &&
      !isSystemOnlyRestaurantItem(item) &&
      !item.placement.wallItem &&
      !item.placement.wallDecorationItem &&
      !item.placement.wallpaperItem &&
      !item.placement.outdoor &&
      !item.placement.floorTileItem
    );
  }

  private availableFor(itemId: number): number {
    if (!this.authorityLoaded) return 0;
    return this.inventoryByItemId.get(itemId)?.available ?? 0;
  }

  private selectRelative(delta: number): void {
    if (
      this.candidates.length === 0 ||
      this.placementInFlight ||
      this.selectedPlacedInstanceId !== null ||
      this.selectedWallpaperRotation !== null
    ) {
      return;
    }
    this.selectedIndex =
      (this.selectedIndex + delta + this.candidates.length) %
      this.candidates.length;
    this.rotation = 0;
    this.refreshSelectedItem();
    this.drawPreview();
  }

  private refreshSelectedItem(): void {
    const state = gameUiBridge.getState();
    gameUiBridge.publish({
      ...state,
      selectedItem: this.selectedItemUi(),
      selectedPlacedItem: this.selectedPlacedItemUi(),
      selectedWallpaper: this.selectedWallpaperUi(),
      selectedWallpaper: this.selectedWallpaperUi(),
    });
  }

  private selectedItemUi(): GameUiState['selectedItem'] {
    const item = this.candidates[this.selectedIndex];
    if (!item?.placementFootprint) return undefined;

    const inventory = this.authorityLoaded
      ? this.inventoryByItemId.get(item.id) ?? {
          itemId: item.id,
          owned: 0,
          placed: 0,
          available: 0,
        }
      : undefined;

    return {
      id: item.id,
      name: item.name,
      group: item.group,
      footprint: `${item.placementFootprint.sizeX}×${item.placementFootprint.sizeY}`,
      rotation:
        this.isAuthoritativeWallpaper(item) && this.hoverTile
          ? (defaultWallAttachmentRotation(this.hoverTile, this.room) ?? 0)
          : this.rotation,
      inventory: inventory
        ? {
            owned: inventory.owned,
            placed: inventory.placed,
            available: inventory.available,
          }
        : undefined,
    };
  }

  private selectedPlacedItem(): AuthoritativePlacedItem | null {
    if (this.selectedPlacedInstanceId === null) return null;
    return (
      this.authoritativeItems.find(
        (item) => item.instanceId === this.selectedPlacedInstanceId,
      ) ?? null
    );
  }

  private selectedPlacedItemUi(): GameUiState['selectedPlacedItem'] {
    const placed = this.selectedPlacedItem();
    if (!placed) return undefined;
    const definition = this.catalogById.get(placed.itemId);
    return {
      instanceId: placed.instanceId,
      itemId: placed.itemId,
      name: definition?.name ?? `item #${placed.itemId}`,
      tileX: placed.tileX,
      tileY: placed.tileY,
      rotation: this.rotation,
    };
  }

  private selectedWallpaper(): AuthoritativeWallpaper | null {
    if (this.selectedWallpaperRotation === null) return null;
    return (
      this.authoritativeWallpapers.find(
        (wallpaper) => wallpaper.rotation === this.selectedWallpaperRotation,
      ) ?? null
    );
  }

  private selectedWallpaperUi(): GameUiState['selectedWallpaper'] {
    const wallpaper = this.selectedWallpaper();
    if (!wallpaper) return undefined;
    const definition = this.catalogById.get(wallpaper.itemId);
    return {
      itemId: wallpaper.itemId,
      name: definition?.name ?? `item #${wallpaper.itemId}`,
      rotation: wallpaper.rotation,
      orientation: wallpaper.rotation === 0 ? 'left' : 'top',
    };
  }

  private currentDefinition(): RestaurantItemDefinition | null {
    const placed = this.selectedPlacedItem();
    if (placed) return this.catalogById.get(placed.itemId) ?? null;
    const wallpaper = this.selectedWallpaper();
    if (wallpaper) return this.catalogById.get(wallpaper.itemId) ?? null;
    return this.candidates[this.selectedIndex] ?? null;
  }

  private selectPlacedItem(instanceId: number): void {
    if (this.placementInFlight || !this.authoritySynchronized) return;
    const placed = this.authoritativeItems.find(
      (item) => item.instanceId === instanceId,
    );
    if (!placed) return;

    this.selectedWallpaperRotation = null;
    this.selectedPlacedInstanceId = placed.instanceId;
    this.rotation = placed.rotation;
    this.hoverTile = { x: placed.tileX, y: placed.tileY };
    this.drawDefaultWalls();
    this.drawCommittedPlacements();
    this.drawPreview(false);
    this.publishUi(
      `Editing placed #${placed.instanceId}. Hover a destination and click the floor to save; Rotate changes the preview.`,
      this.currentValidation(),
    );
  }

  private selectWallpaperSlot(rotation: 0 | 1): void {
    if (this.placementInFlight || !this.authoritySynchronized) return;
    const wallpaper = this.authoritativeWallpapers.find(
      (entry) => entry.rotation === rotation,
    );
    if (!wallpaper) return;

    this.selectedPlacedInstanceId = null;
    this.selectedWallpaperRotation = rotation;
    this.rotation = rotation;
    this.drawDefaultWalls();
    this.drawCommittedPlacements();
    this.drawPreview(false);
    this.publishUi(
      `Editing ${rotation === 0 ? 'left' : 'top'} wallpaper slot. Remove clears the whole orientation; choosing another wallpaper replaces it.`,
      null,
    );
  }

  private cancelSelectedEdit(): void {
    if (
      this.placementInFlight ||
      (this.selectedPlacedInstanceId === null &&
        this.selectedWallpaperRotation === null)
    ) {
      return;
    }

    const placedInstanceId = this.selectedPlacedInstanceId;
    const wallpaperRotation = this.selectedWallpaperRotation;
    this.selectedPlacedInstanceId = null;
    this.selectedWallpaperRotation = null;
    this.rotation = 0;
    this.drawDefaultWalls();
    this.drawCommittedPlacements();
    this.drawPreview(false);
    this.publishUi(
      placedInstanceId !== null
        ? `Cancelled edit for placed #${placedInstanceId}. No authoritative state was changed.`
        : `Cancelled ${wallpaperRotation === 0 ? 'left' : 'top'} wallpaper edit. No authoritative state was changed.`,
      this.currentValidation(),
    );
  }

  private publishUi(
    status: string,
    validation: EditorPlacementValidation | null = null,
    phase: GameUiState['phase'] = 'editing',
  ): void {
    const state = gameUiBridge.getState();
    gameUiBridge.publish({
      ...state,
      phase,
      status,
      selectedItem: this.selectedItemUi(),
      selectedPlacedItem: this.selectedPlacedItemUi(),
      selectedWallpaper: this.selectedWallpaperUi(),
      placement:
        validation && this.hoverTile
          ? {
              tileX: this.hoverTile.x,
              tileY: this.hoverTile.y,
              valid: validation.ok,
              detail: validation.ok
                ? `valid · roomIndex=${validation.roomIndex}`
                : validation.reason,
            }
          : undefined,
    });
  }

  private currentShape(): PlacementShape | null {
    const item = this.currentDefinition();
    if (!item?.placementFootprint) return null;
    const footprint = rotateFootprint(item.placementFootprint, this.rotation);
    return { ...footprint, ...item.placement };
  }

  private currentValidation(): EditorPlacementValidation | null {
    if (this.selectedWallpaperRotation !== null) return null;

    const shape = this.currentShape();
    const tile = this.hoverTile;
    const item = this.currentDefinition();
    if (!shape || !tile || !item) return null;

    if (this.authorityLoaded && !this.authoritySynchronized) {
      return { ok: false, reason: 'authority-desynced' };
    }

    if (this.isAuthoritativeWallpaper(item)) {
      const targetRotation = defaultWallAttachmentRotation(tile, this.room);
      if (targetRotation !== 0 && targetRotation !== 1) {
        return { ok: false, reason: 'wall-required' };
      }

      const current = this.authoritativeWallpapers.find(
        (wallpaper) => wallpaper.rotation === targetRotation,
      );
      if (
        this.authorityLoaded &&
        current?.itemId !== item.id &&
        this.availableFor(item.id) <= 0
      ) {
        return { ok: false, reason: 'unavailable' };
      }

      return { ok: true, roomIndex: 0 };
    }

    const structural = validateStructuralPlacement(shape, tile, this.room);
    if (!structural.ok) return structural;

    if (
      this.selectedPlacedInstanceId === null &&
      this.authorityLoaded &&
      this.availableFor(item.id) <= 0
    ) {
      return { ok: false, reason: 'unavailable' };
    }

    if (
      this.overlapsCommittedItem(
        item,
        tile,
        shape,
        structural.roomIndex,
        this.selectedPlacedInstanceId,
      )
    ) {
      return { ok: false, reason: 'occupied' };
    }

    return structural;
  }

  private overlapsCommittedItem(
    candidate: RestaurantItemDefinition,
    tile: TilePoint,
    shape: PlacementShape,
    roomIndex: number,
    selfInstanceId: number | null = null,
  ): boolean {
    // WorldRestaurant.itemMap is bottom -> top. The authority returns its
    // snapshot in that same order, so preserve it while filtering each tile.
    for (let dx = 0; dx < shape.sizeX; dx += 1) {
      for (let dy = 0; dy < shape.sizeY; dy += 1) {
        const tileX = tile.x + dx;
        const tileY = tile.y + dy;
        const stack = this.authoritativeItems.flatMap((placed) => {
          if (placed.roomIndex !== roomIndex) return [];

          const definition = this.catalogById.get(placed.itemId);
          if (!definition?.placementFootprint) {
            // Fail closed if authority somehow references geometry the client
            // cannot reproduce.
            return [{ instanceId: placed.instanceId, surface: false }];
          }

          const footprint = rotateFootprint(
            definition.placementFootprint,
            placed.rotation,
          );
          const contains =
            tileX >= placed.tileX &&
            tileX < placed.tileX + footprint.sizeX &&
            tileY >= placed.tileY &&
            tileY < placed.tileY + footprint.sizeY;
          return contains
            ? [
                {
                  instanceId: placed.instanceId,
                  surface: definition.placement.surface === true,
                },
              ]
            : [];
        });

        const result = validateHistoricalTileStack(
          { stackable: candidate.placement.stackable },
          stack,
          selfInstanceId ?? undefined,
        );
        if (!result.ok) return true;
      }
    }

    return false;
  }

  private async commitCurrentMutation(): Promise<void> {
    if (this.selectedWallpaperRotation !== null) return;

    if (this.selectedPlacedInstanceId !== null) {
      await this.commitSelectedTransform();
      return;
    }

    const item = this.candidates[this.selectedIndex];
    if (item && this.isAuthoritativeWallpaper(item)) {
      await this.commitCurrentWallpaper();
      return;
    }

    await this.commitCurrentPlacement();
  }

  private async commitCurrentWallpaper(): Promise<void> {
    if (
      this.placementInFlight ||
      !this.hoverTile ||
      this.candidates.length === 0 ||
      !this.authorityLoaded
    ) {
      return;
    }

    if (!this.authoritySynchronized) {
      await this.resynchronizeAuthority();
      return;
    }

    const item = this.candidates[this.selectedIndex];
    const validation = this.currentValidation();
    const targetRotation = defaultWallAttachmentRotation(
      this.hoverTile,
      this.room,
    );
    if (
      !item ||
      !this.isAuthoritativeWallpaper(item) ||
      !validation?.ok ||
      (targetRotation !== 0 && targetRotation !== 1)
    ) {
      if (validation) {
        this.publishUi('Wallpaper cannot be committed.', validation);
      }
      return;
    }

    const tile = { ...this.hoverTile };
    const mutationId = createWallpaperMutationId();
    this.placementInFlight = true;
    this.publishUi(
      `Saving ${targetRotation === 0 ? 'left' : 'top'} wallpaper #${item.id}…`,
      validation,
      'saving',
    );

    try {
      const commit = await this.authority.applyWallpaper(
        {
          itemId: item.id,
          tileX: tile.x,
          tileY: tile.y,
        },
        mutationId,
      );
      const layout = await this.authority.loadRestaurant();
      const persisted = layout.wallpapers.some(
        (wallpaper) =>
          wallpaper.itemId === commit.wallpaper.itemId &&
          wallpaper.rotation === commit.wallpaper.rotation,
      );
      if (!persisted) {
        throw new Error(
          'Authoritative reload did not contain the wallpaper acknowledged by the server',
        );
      }

      this.rotation = commit.wallpaper.rotation;
      this.applyAuthoritativeLayout(layout);
      this.drawPreview(false);
      this.publishUi(
        commit.outcome === 'duplicate'
          ? `${commit.wallpaper.rotation === 0 ? 'Left' : 'Top'} wallpaper reconciled and reloaded.`
          : `${commit.wallpaper.rotation === 0 ? 'Left' : 'Top'} wallpaper saved and applied to every matching wall segment.`,
        this.currentValidation(),
      );
    } catch (error) {
      this.handleMutationFailure('Wallpaper', error);
    } finally {
      this.placementInFlight = false;
    }
  }

  private async commitCurrentPlacement(): Promise<void> {
    if (
      this.placementInFlight ||
      !this.hoverTile ||
      this.candidates.length === 0 ||
      !this.authorityLoaded
    ) {
      return;
    }

    if (!this.authoritySynchronized) {
      await this.resynchronizeAuthority();
      return;
    }

    const item = this.candidates[this.selectedIndex];
    const validation = this.currentValidation();
    if (!item || this.isAuthoritativeWallpaper(item) || !validation?.ok) {
      if (validation) {
        this.publishUi('Placement cannot be committed.', validation);
      }
      return;
    }

    const tile = { ...this.hoverTile };
    const rotation = this.rotation;
    const mutationId = createPlacementMutationId();
    this.placementInFlight = true;

    this.publishUi(
      `Saving item #${item.id} at ${tile.x},${tile.y}…`,
      validation,
      'saving',
    );

    try {
      const commit = await this.authority.placeItem(
        {
          itemId: item.id,
          tileX: tile.x,
          tileY: tile.y,
          rotation,
        },
        mutationId,
      );

      const layout = await this.authority.loadRestaurant();
      this.applyAuthoritativeLayout(layout);

      const persisted = layout.items.some(
        (placed) =>
          placed.instanceId === commit.item.instanceId &&
          placed.itemId === commit.item.itemId &&
          placed.tileX === commit.item.tileX &&
          placed.tileY === commit.item.tileY &&
          placed.rotation === commit.item.rotation &&
          placed.roomIndex === commit.item.roomIndex,
      );
      if (!persisted) {
        throw new Error(
          'Authoritative reload did not contain the placement acknowledged by the server',
        );
      }

      this.drawPreview(false);
      this.publishUi(
        commit.outcome === 'duplicate'
          ? `Placement #${commit.item.instanceId} reconciled and reloaded.`
          : `Placement #${commit.item.instanceId} saved and reloaded from authority.`,
        this.currentValidation(),
      );
    } catch (error) {
      const knownRejection =
        error instanceof RestaurantAuthorityError &&
        [400, 401, 403, 409, 422].includes(error.status);

      this.authoritySynchronized = knownRejection;
      this.drawPreview(false);
      this.publishUi(
        knownRejection
          ? this.describeAuthorityError(error)
          : `Placement result is uncertain. New placement is blocked until authoritative reload succeeds: ${this.describeError(error)}`,
        this.currentValidation(),
        error instanceof RestaurantAuthorityError && error.status === 401
          ? 'error'
          : 'editing',
      );
    } finally {
      this.placementInFlight = false;
    }
  }

  private async commitSelectedTransform(): Promise<void> {
    const selected = this.selectedPlacedItem();
    if (
      this.placementInFlight ||
      !selected ||
      !this.hoverTile ||
      !this.authorityLoaded
    ) {
      return;
    }

    if (!this.authoritySynchronized) {
      await this.resynchronizeAuthority();
      return;
    }

    const validation = this.currentValidation();
    if (!validation?.ok) {
      if (validation) {
        this.publishUi('Move cannot be committed.', validation);
      }
      return;
    }

    const tile = { ...this.hoverTile };
    const rotation = this.rotation;
    const mutationId = createTransformMutationId();
    this.placementInFlight = true;
    this.publishUi(
      `Saving placed #${selected.instanceId} at ${tile.x},${tile.y}…`,
      validation,
      'saving',
    );

    try {
      const commit = await this.authority.transformItem(
        selected.instanceId,
        {
          tileX: tile.x,
          tileY: tile.y,
          rotation,
        },
        mutationId,
      );

      const layout = await this.authority.loadRestaurant();
      this.applyAuthoritativeLayout(layout);

      const persisted = layout.items.some(
        (placed) =>
          placed.instanceId === commit.item.instanceId &&
          placed.itemId === commit.item.itemId &&
          placed.tileX === commit.item.tileX &&
          placed.tileY === commit.item.tileY &&
          placed.rotation === commit.item.rotation &&
          placed.roomIndex === commit.item.roomIndex,
      );
      if (!persisted) {
        throw new Error(
          'Authoritative reload did not contain the transformed item acknowledged by the server',
        );
      }

      this.selectedPlacedInstanceId = commit.item.instanceId;
      this.hoverTile = { x: commit.item.tileX, y: commit.item.tileY };
      this.rotation = commit.item.rotation;
      this.drawCommittedPlacements();
      this.drawPreview(false);
      this.publishUi(
        commit.outcome === 'duplicate'
          ? `Edit #${commit.item.instanceId} reconciled and reloaded.`
          : `Edit #${commit.item.instanceId} saved and reloaded from authority.`,
        this.currentValidation(),
      );
    } catch (error) {
      this.handleMutationFailure('Edit', error);
    } finally {
      this.placementInFlight = false;
    }
  }

  private async removeSelectedAuthorityState(): Promise<void> {
    if (this.selectedWallpaperRotation !== null) {
      await this.removeSelectedWallpaper();
      return;
    }
    await this.removeSelectedPlacedItem();
  }

  private async removeSelectedWallpaper(): Promise<void> {
    const selected = this.selectedWallpaper();
    if (this.placementInFlight || !selected || !this.authorityLoaded) return;

    if (!this.authoritySynchronized) {
      await this.resynchronizeAuthority();
      return;
    }

    const mutationId = createWallpaperMutationId();
    this.placementInFlight = true;
    this.publishUi(
      `Removing ${selected.rotation === 0 ? 'left' : 'top'} wallpaper…`,
      null,
      'saving',
    );

    try {
      const commit = await this.authority.removeWallpaper(
        selected.rotation,
        mutationId,
      );
      const layout = await this.authority.loadRestaurant();
      if (
        layout.wallpapers.some(
          (wallpaper) => wallpaper.rotation === commit.wallpaper.rotation,
        )
      ) {
        throw new Error(
          'Authoritative reload still contains the wallpaper acknowledged as removed',
        );
      }

      this.selectedWallpaperRotation = null;
      this.rotation = 0;
      this.applyAuthoritativeLayout(layout);
      this.drawPreview(false);
      this.publishUi(
        commit.outcome === 'duplicate'
          ? `${commit.wallpaper.rotation === 0 ? 'Left' : 'Top'} wallpaper removal reconciled.`
          : `${commit.wallpaper.rotation === 0 ? 'Left' : 'Top'} wallpaper removed and inventory reconciled.`,
        this.currentValidation(),
      );
    } catch (error) {
      this.handleMutationFailure('Wallpaper removal', error);
    } finally {
      this.placementInFlight = false;
    }
  }

  private async removeSelectedPlacedItem(): Promise<void> {
    const selected = this.selectedPlacedItem();
    if (this.placementInFlight || !selected || !this.authorityLoaded) return;

    if (!this.authoritySynchronized) {
      await this.resynchronizeAuthority();
      return;
    }

    const mutationId = createRemoveMutationId();
    this.placementInFlight = true;
    this.publishUi(
      `Removing placed #${selected.instanceId}…`,
      null,
      'saving',
    );

    try {
      const commit = await this.authority.removeItem(
        selected.instanceId,
        mutationId,
      );
      const layout = await this.authority.loadRestaurant();

      if (
        layout.items.some(
          (placed) => placed.instanceId === commit.item.instanceId,
        )
      ) {
        throw new Error(
          'Authoritative reload still contains the item acknowledged as removed',
        );
      }

      this.selectedPlacedInstanceId = null;
      this.rotation = 0;
      this.applyAuthoritativeLayout(layout);
      this.drawPreview(false);
      this.publishUi(
        commit.outcome === 'duplicate'
          ? `Removal #${commit.item.instanceId} reconciled; item is absent.`
          : `Placed #${commit.item.instanceId} removed and inventory reconciled.`,
        this.currentValidation(),
      );
    } catch (error) {
      this.handleMutationFailure('Removal', error);
    } finally {
      this.placementInFlight = false;
    }
  }

  private handleMutationFailure(operation: string, error: unknown): void {
    const knownRejection =
      error instanceof RestaurantAuthorityError &&
      [400, 401, 403, 409, 422].includes(error.status);

    this.authoritySynchronized = knownRejection;
    this.drawCommittedPlacements();
    this.drawPreview(false);
    this.publishUi(
      knownRejection
        ? this.describeAuthorityError(error)
        : `${operation} result is uncertain. Further mutation is blocked until authoritative reload succeeds: ${this.describeError(error)}`,
      this.currentValidation(),
      error instanceof RestaurantAuthorityError && error.status === 401
        ? 'error'
        : 'editing',
    );
  }

  private async resynchronizeAuthority(): Promise<void> {
    if (this.placementInFlight) return;
    this.placementInFlight = true;
    this.publishUi(
      'Resynchronizing authoritative restaurant state…',
      null,
      'saving',
    );

    try {
      const layout = await this.authority.loadRestaurant();
      this.applyAuthoritativeLayout(layout);
      this.drawPreview(false);
      this.publishUi(
        `Authoritative state resynchronized: ${layout.items.length} object(s), ${layout.floorTiles.length} floor tile(s), ${layout.wallpapers.length} wallpaper slot(s).`,
        this.currentValidation(),
      );
    } catch (error) {
      this.authoritySynchronized = false;
      this.publishUi(
        `Authoritative resynchronization failed: ${this.describeError(error)}`,
        null,
        error instanceof RestaurantAuthorityError && error.status === 401
          ? 'error'
          : 'editing',
      );
    } finally {
      this.placementInFlight = false;
    }
  }

  private drawDefaultWalls(): void {
    this.clearAuthoritativeWallCutouts();
    this.clearAuthoritativeWallpaperLayers();
    for (const sprite of this.wallSprites) sprite.destroy();
    this.wallSprites = [];

    if (!this.visualIndex || this.catalogById.size === 0) return;

    const wall = this.catalogById.get(DEFAULT_WALL_ITEM_ID);
    const corner = this.catalogById.get(DEFAULT_WALL_CORNER_ITEM_ID);
    if (!wall?.placementFootprint || !corner?.placementFootprint) {
      throw new Error('Recovered default wall geometry is unavailable');
    }

    const wallVisual = this.itemVisual(wall);
    const cornerVisual = this.itemVisual(corner);
    if (!wallVisual || wallVisual.frames.length < 2 || !cornerVisual) {
      throw new Error('Recovered default wall visuals are unavailable');
    }

    for (let x = 1; x < this.room.insideX; x += 1) {
      const sprite = this.createItemSprite(
        wall,
        wallVisual,
        1,
        { x, y: 0 },
        1,
      );
      this.wallSprites.push(sprite);
    }

    for (let y = 1; y < this.room.insideY; y += 1) {
      const sprite = this.createItemSprite(
        wall,
        wallVisual,
        0,
        { x: 0, y },
        1,
      );
      this.wallSprites.push(sprite);
    }

    this.wallSprites.push(
      this.createItemSprite(
        corner,
        cornerVisual,
        0,
        { x: 0, y: 0 },
        1,
      ),
    );

    this.drawAuthoritativeWallpapers();
    this.drawDoorEraseProbe();
    this.publishVisualProbeDiagnostics();
  }

  private clearAuthoritativeWallCutouts(): void {
    for (const source of this.wallCutoutSources) {
      if (source.active) source.setVisible(true);
    }
    for (const texture of this.wallCutoutTextures) texture.destroy();
    this.wallCutoutSources = [];
    this.wallCutoutTextures = [];
  }

  private wallLayerKey(tile: TilePoint): string {
    return `${tile.x}:${tile.y}`;
  }

  private clearAuthoritativeWallpaperLayers(): void {
    for (const layer of this.wallpaperWallLayers.values()) {
      if (layer.sourceWall.active) layer.sourceWall.setVisible(true);
      layer.texture.destroy();
    }
    this.wallpaperWallLayers.clear();
    const target = globalThis as typeof globalThis & {
      __ANEWON_RC_WALLPAPER_DIAGNOSTICS__?: unknown;
    };
    target.__ANEWON_RC_WALLPAPER_DIAGNOSTICS__ = [];
  }

  private wallpaperForRotation(rotation: number): AuthoritativeWallpaper | null {
    return (
      this.authoritativeWallpapers.find(
        (wallpaper) => wallpaper.rotation === rotation,
      ) ?? null
    );
  }

  private createWallpaperStamp(
    wallpaper: AuthoritativeWallpaper,
  ): {
    readonly definition: RestaurantItemDefinition;
    readonly visual: RestaurantItemVisual;
    readonly frameName: string;
    readonly offset: { readonly x: number; readonly y: number };
    readonly stamp: Phaser.GameObjects.Image;
  } {
    const definition = this.catalogById.get(wallpaper.itemId);
    if (!definition || !this.isAuthoritativeWallpaper(definition)) {
      throw new Error(
        `Authoritative wallpaper references unsupported item #${wallpaper.itemId}`,
      );
    }
    const visual = this.itemVisual(definition);
    const frame = recoveredWallpaperFrame(
      definition.id,
      definition.className,
      wallpaper.rotation,
    );
    if (!visual || !frame || !visual.frames.includes(frame.frame)) {
      throw new Error(
        `Recovered wallpaper raster is unavailable for #${wallpaper.itemId} rotation ${wallpaper.rotation}`,
      );
    }
    const atlasFrame = this.textures.getFrame(visual.atlasId, frame.frame);
    if (!atlasFrame) {
      throw new Error(`Wallpaper atlas frame missing: ${frame.frame}`);
    }
    return {
      definition,
      visual,
      frameName: frame.frame,
      offset: frame.canvasOriginPx,
      stamp: this.make
        .image({
          x: 0,
          y: 0,
          key: visual.atlasId,
          frame: frame.frame,
          add: false,
        })
        .setOrigin(0, 0),
    };
  }

  private composeWallpaperWall(
    wallpaper: AuthoritativeWallpaper,
    tile: TilePoint,
  ): {
    readonly texture: Phaser.GameObjects.RenderTexture;
    readonly sourceWall: Phaser.GameObjects.Sprite;
    readonly wallpaperFrame: string;
    readonly wallpaperLocal: { readonly x: number; readonly y: number };
    readonly wallFrame: string;
  } {
    const wall = this.catalogById.get(DEFAULT_WALL_ITEM_ID);
    if (!wall?.placementFootprint) {
      throw new Error('Recovered default wall geometry is unavailable');
    }
    const wallVisual = this.itemVisual(wall);
    if (!wallVisual || wallpaper.rotation >= wallVisual.frames.length) {
      throw new Error('Recovered default wall visual is unavailable');
    }

    const wallFrameName = frameForRestaurantItemRotation(
      wallVisual,
      wallpaper.rotation,
    );
    const wallFrame = this.textures.getFrame(wallVisual.atlasId, wallFrameName);
    const wallOffset = recoveredWallFloorFrameOffset(
      wall.id,
      wall.className,
      wallpaper.rotation,
    );
    if (!wallFrame || !wallOffset) {
      throw new Error('Recovered wallpaper wall frame/origin is unavailable');
    }

    const projected = projectTile(tile);
    const wallX = ORIGIN.x + projected.x + wallOffset.x;
    const wallY = ORIGIN.y + projected.y + wallOffset.y;
    const sourceWall = this.wallSprites.find(
      (candidate) =>
        candidate.frame.name === wallFrameName &&
        Math.abs(candidate.x - wallX) < 0.01 &&
        Math.abs(candidate.y - wallY) < 0.01,
    );
    if (!sourceWall) {
      throw new Error(
        `Wallpaper could not resolve default wall at ${tile.x},${tile.y}`,
      );
    }

    const wallStamp = this.make
      .image({
        x: 0,
        y: 0,
        key: wallVisual.atlasId,
        frame: wallFrameName,
        add: false,
      })
      .setOrigin(0, 0);
    const wallpaperStamp = this.createWallpaperStamp(wallpaper);
    const texture = this.add
      .renderTexture(wallX, wallY, wallFrame.width, wallFrame.height)
      .setOrigin(0, 0)
      .setDepth(sourceWall.depth);
    texture.draw(wallStamp, 0, 0);
    const wallpaperLocal = {
      x: wallpaperStamp.offset.x - wallOffset.x,
      y: wallpaperStamp.offset.y - wallOffset.y,
    };
    texture.draw(
      wallpaperStamp.stamp,
      wallpaperLocal.x,
      wallpaperLocal.y,
    );

    wallStamp.destroy();
    wallpaperStamp.stamp.destroy();
    sourceWall.setVisible(false);
    return {
      texture,
      sourceWall,
      wallpaperFrame: wallpaperStamp.frameName,
      wallpaperLocal,
      wallFrame: wallFrameName,
    };
  }

  private drawAuthoritativeWallpapers(): void {
    const diagnostics: Array<{
      readonly itemId: number;
      readonly rotation: number;
      readonly tile: TilePoint;
      readonly wallpaperFrame: string;
      readonly wallFrame: string;
      readonly wallpaperLocal: { readonly x: number; readonly y: number };
      readonly wallWorld: {
        readonly x: number;
        readonly y: number;
        readonly depth: number;
      };
    }> = [];

    for (const wallpaper of this.authoritativeWallpapers) {
      const tiles: TilePoint[] = [];
      if (wallpaper.rotation === 0) {
        for (let y = 1; y < this.room.insideY; y += 1) {
          tiles.push({ x: 0, y });
        }
      } else {
        for (let x = 1; x < this.room.insideX; x += 1) {
          tiles.push({ x, y: 0 });
        }
      }

      for (const tile of tiles) {
        const composed = this.composeWallpaperWall(wallpaper, tile);
        composed.texture
          .setAlpha(
            this.selectedWallpaperRotation === wallpaper.rotation ? 0.55 : 1,
          )
          .setInteractive({ useHandCursor: true });
        composed.texture.on(
          'pointerdown',
          (
            _pointer: Phaser.Input.Pointer,
            _localX: number,
            _localY: number,
            event: Phaser.Types.Input.EventData,
          ) => {
            event.stopPropagation();
            this.selectWallpaperSlot(wallpaper.rotation);
          },
        );
        this.wallpaperWallLayers.set(this.wallLayerKey(tile), {
          texture: composed.texture,
          sourceWall: composed.sourceWall,
          wallpaper,
          tile,
        });
        diagnostics.push({
          itemId: wallpaper.itemId,
          rotation: wallpaper.rotation,
          tile,
          wallpaperFrame: composed.wallpaperFrame,
          wallFrame: composed.wallFrame,
          wallpaperLocal: composed.wallpaperLocal,
          wallWorld: {
            x: composed.texture.x,
            y: composed.texture.y,
            depth: composed.texture.depth,
          },
        });
      }
    }

    const target = globalThis as typeof globalThis & {
      __ANEWON_RC_WALLPAPER_DIAGNOSTICS__?: unknown;
    };
    target.__ANEWON_RC_WALLPAPER_DIAGNOSTICS__ = diagnostics;
  }

  private renderDoorWallComposition(
    door: RestaurantItemDefinition,
    doorVisual: RestaurantItemVisual,
    rotation: number,
    tile: TilePoint,
    alpha: number,
    includeDoor: boolean,
  ): {
    wallTexture: Phaser.GameObjects.RenderTexture;
    sourceWall: Phaser.GameObjects.Sprite;
    sourceLayer: Phaser.GameObjects.Sprite | Phaser.GameObjects.RenderTexture;
    doorSprite: Phaser.GameObjects.Sprite | null;
    wallFrame: string;
    maskFrame: string;
    maskLocal: { x: number; y: number };
  } {
    if (rotation !== 0 && rotation !== 1) {
      throw new Error(`Recovered Simple Door rotation is unsupported: ${rotation}`);
    }

    const wall = this.catalogById.get(DEFAULT_WALL_ITEM_ID);
    if (!wall?.placementFootprint) {
      throw new Error('Recovered default wall geometry is unavailable');
    }
    const wallVisual = this.itemVisual(wall);
    const mask = recoveredDoorMaskRaster(door.id, door.className);
    if (
      !wallVisual ||
      wallVisual.frames.length < 2 ||
      !door.placementFootprint ||
      doorVisual.frames.length !== 2 ||
      !mask
    ) {
      throw new Error('Recovered Simple Door composition contract is unavailable');
    }

    const wallFrameName = frameForRestaurantItemRotation(wallVisual, rotation);
    const wallFrame = this.textures.getFrame(wallVisual.atlasId, wallFrameName);
    const wallOffset = recoveredWallFloorFrameOffset(
      wall.id,
      wall.className,
      rotation,
    );
    if (!wallFrame || !wallOffset) {
      throw new Error('Recovered Door wall frame/origin is unavailable');
    }

    const projected = projectTile(tile);
    const wallX = ORIGIN.x + projected.x + wallOffset.x;
    const wallY = ORIGIN.y + projected.y + wallOffset.y;
    const sourceWall = this.wallSprites.find(
      (candidate) =>
        candidate.frame.name === wallFrameName &&
        Math.abs(candidate.x - wallX) < 0.01 &&
        Math.abs(candidate.y - wallY) < 0.01,
    );
    if (!sourceWall) {
      throw new Error(
        `Simple Door could not resolve default wall at ${tile.x},${tile.y}`,
      );
    }
    const wallpaperLayer = this.wallpaperWallLayers.get(this.wallLayerKey(tile));
    const sourceLayer = wallpaperLayer?.texture ?? sourceWall;
    sourceLayer.setVisible(false);

    const wallStamp = this.make
      .image({
        x: 0,
        y: 0,
        key: wallVisual.atlasId,
        frame: wallFrameName,
        add: false,
      })
      .setOrigin(0, 0);
    const maskStamp = this.make
      .image({
        x: 0,
        y: 0,
        key: wallVisual.atlasId,
        frame: mask.frame,
        add: false,
      })
      .setOrigin(0, 0);

    // WorldRestaurant.placeRoomItem clones mc_mask into the target wall,
    // translates it by the negative tile/sub-item screen offset and applies
    // BlendMode.ERASE while the wall is BlendMode.LAYER. For this 1x1 Door
    // the recovered raster origins reduce that composition to this exact local
    // offset inside the matching Wall2 frame.
    const maskX = mask.canvasOriginPx.x - wallOffset.x;
    const maskY = mask.canvasOriginPx.y - wallOffset.y;
    const wallTexture = this.add
      .renderTexture(wallX, wallY, wallFrame.width, wallFrame.height)
      .setOrigin(0, 0)
      .setDepth(sourceWall.depth);
    wallTexture.draw(wallStamp, 0, 0);
    const wallpaper = this.wallpaperForRotation(rotation);
    if (wallpaper) {
      const wallpaperStamp = this.createWallpaperStamp(wallpaper);
      wallTexture.draw(
        wallpaperStamp.stamp,
        wallpaperStamp.offset.x - wallOffset.x,
        wallpaperStamp.offset.y - wallOffset.y,
      );
      wallpaperStamp.stamp.destroy();
    }
    wallTexture.erase(maskStamp, maskX, maskY);
    wallStamp.destroy();
    maskStamp.destroy();

    let doorSprite: Phaser.GameObjects.Sprite | null = null;
    if (includeDoor) {
      doorSprite = this.createItemSprite(
        door,
        doorVisual,
        rotation,
        tile,
        alpha,
      );
      // Exact WorldRestaurant.placeRoomItem door branch:
      // rot0 => getTileDrawPriority(x + 1, y) - 1
      // rot1 => getTileDrawPriority(x - 1, y + 1)
      doorSprite.setDepth(
        rotation === 0
          ? this.itemDrawPriority({ x: tile.x + 1, y: tile.y }) - 1
          : this.itemDrawPriority({ x: tile.x - 1, y: tile.y + 1 }),
      );
    }

    return {
      wallTexture,
      sourceWall,
      sourceLayer,
      doorSprite,
      wallFrame: wallFrameName,
      maskFrame: mask.frame,
      maskLocal: { x: maskX, y: maskY },
    };
  }

  private drawDoorEraseProbe(): void {
    this.doorProbeWall?.destroy();
    this.doorProbeDoor?.destroy();
    this.doorProbeWall = null;
    this.doorProbeDoor = null;

    if (typeof window === 'undefined') return;
    const probeParams = new URLSearchParams(window.location.search);
    if (!probeParams.has('doorProbe')) return;

    const door = this.catalogById.get(SIMPLE_DOOR_ITEM_ID);
    if (!door?.placementFootprint) {
      throw new Error('Recovered Simple Door geometry is unavailable');
    }
    const doorVisual = this.itemVisual(door);
    const mask = recoveredDoorMaskRaster(door.id, door.className);
    if (!doorVisual || doorVisual.frames.length !== 2 || !mask) {
      throw new Error('Recovered Simple Door raster contract is unavailable');
    }

    const requestedRotation = Number.parseInt(
      probeParams.get('doorProbeRotation') ?? '1',
      10,
    );
    const rotation = requestedRotation === 0 ? 0 : 1;
    const tile: TilePoint =
      rotation === 0 ? { x: 0, y: 2 } : { x: 2, y: 0 };
    const maskOnly = probeParams.has('doorMaskOnly');
    const composition = this.renderDoorWallComposition(
      door,
      doorVisual,
      rotation,
      tile,
      1,
      !maskOnly,
    );
    this.doorProbeWall = composition.wallTexture;
    this.doorProbeDoor = composition.doorSprite;

    const target = globalThis as typeof globalThis & {
      __ANEWON_RC_DOOR_PROBE__?: unknown;
    };
    target.__ANEWON_RC_DOOR_PROBE__ = {
      tile,
      rotation,
      maskOnly,
      wallFrame: composition.wallFrame,
      wallWorld: {
        x: composition.wallTexture.x,
        y: composition.wallTexture.y,
        depth: composition.wallTexture.depth,
      },
      maskFrame: composition.maskFrame,
      maskLocal: composition.maskLocal,
      doorFrame: composition.doorSprite?.frame.name ?? null,
      doorWorld: composition.doorSprite
        ? {
            x: composition.doorSprite.x,
            y: composition.doorSprite.y,
            depth: composition.doorSprite.depth,
          }
        : null,
    };
  }

  private publishVisualProbeDiagnostics(): void {
    if (
      typeof window === 'undefined' ||
      !new URLSearchParams(window.location.search).has('visualProbe')
    ) {
      return;
    }

    const describe = (
      sprite: Phaser.GameObjects.Sprite | Phaser.GameObjects.Image,
    ) => {
      const bounds = sprite.getBounds();
      const frame = sprite.frame as Phaser.Textures.Frame & {
        glTexture?: unknown;
      };
      const source = sprite.texture.source[frame.sourceIndex];
      return {
        frame: frame.name,
        textureKey: sprite.texture.key,
        sourceIndex: frame.sourceIndex,
        sourceLoaded: Boolean(source?.image),
        sourceWidth: source?.width ?? null,
        sourceHeight: source?.height ?? null,
        sourceGlTexturePresent: Boolean(source?.glTexture),
        frameGlTexturePresent: Boolean(frame.glTexture),
        cutX: frame.cutX,
        cutY: frame.cutY,
        cutWidth: frame.cutWidth,
        cutHeight: frame.cutHeight,
        realWidth: frame.realWidth,
        realHeight: frame.realHeight,
        u0: frame.u0,
        v0: frame.v0,
        u1: frame.u1,
        v1: frame.v1,
        inSceneDisplayList: sprite.displayList === this.sys.displayList,
        sceneChildrenContains: this.children.exists(sprite),
        x: sprite.x,
        y: sprite.y,
        depth: sprite.depth,
        visible: sprite.visible,
        alpha: sprite.alpha,
        active: sprite.active,
        renderFlags: sprite.renderFlags,
        cameraFilter: sprite.cameraFilter,
        willRender: sprite.willRender(this.cameras.main),
        blendMode: sprite.blendMode,
        pipeline: sprite.pipeline?.name ?? null,
        tintTopLeft: sprite.tintTopLeft,
        tintTopRight: sprite.tintTopRight,
        tintBottomLeft: sprite.tintBottomLeft,
        tintBottomRight: sprite.tintBottomRight,
        alphaTopLeft: sprite.alphaTopLeft,
        alphaTopRight: sprite.alphaTopRight,
        alphaBottomLeft: sprite.alphaBottomLeft,
        alphaBottomRight: sprite.alphaBottomRight,
        width: sprite.displayWidth,
        height: sprite.displayHeight,
        bounds: {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        },
      };
    };

    const target = globalThis as typeof globalThis & {
      __ANEWON_RC_VISUAL_DIAGNOSTICS__?: unknown;
    };
    target.__ANEWON_RC_VISUAL_DIAGNOSTICS__ = {
      walls: this.wallSprites.map(describe),
      committed: this.committedSprites.map(describe),
      floor: this.floorSprites.map(describe),
    };
  }

  private drawCommittedPlacements(): void {
    this.clearAuthoritativeWallCutouts();
    this.committedGraphics.clear();
    for (const sprite of this.committedSprites) sprite.destroy();
    this.committedSprites = [];

    const curHeights = this.computeCurHeights(this.authoritativeItems);

    for (const placed of this.authoritativeItems) {
      const definition = this.catalogById.get(placed.itemId);
      if (!definition?.placementFootprint) continue;

      const visual = this.itemVisual(definition);
      if (!visual) {
        throw new Error(
          `Authoritative item #${placed.itemId} has no runtime atlas visual`,
        );
      }

      this.committedGraphics.lineStyle(2, 0x5aa5d8, 0.95);
      this.committedGraphics.fillStyle(0x5aa5d8, 0.14);
      this.drawTileFootprint(
        this.committedGraphics,
        { x: placed.tileX, y: placed.tileY },
        rotateFootprint(definition.placementFootprint, placed.rotation),
        true,
      );
      const selected =
        placed.instanceId === this.selectedPlacedInstanceId;
      if (selected) {
        this.committedGraphics.lineStyle(3, 0xffd166, 1);
        this.committedGraphics.fillStyle(0xffd166, 0.18);
        this.drawTileFootprint(
          this.committedGraphics,
          { x: placed.tileX, y: placed.tileY },
          rotateFootprint(definition.placementFootprint, placed.rotation),
          true,
        );
      }

      const alpha = selected ? 0.35 : 1;
      const sprite =
        definition.id === SIMPLE_DOOR_ITEM_ID
          ? (() => {
              const composition = this.renderDoorWallComposition(
                definition,
                visual,
                placed.rotation,
                { x: placed.tileX, y: placed.tileY },
                alpha,
                true,
              );
              if (!composition.doorSprite) {
                throw new Error('Authoritative Simple Door sprite was not created');
              }
              this.wallCutoutTextures.push(composition.wallTexture);
              this.wallCutoutSources.push(composition.sourceLayer);
              return composition.doorSprite;
            })()
          : this.createItemSprite(
              definition,
              visual,
              placed.rotation,
              { x: placed.tileX, y: placed.tileY },
              alpha,
              curHeights.get(placed.instanceId) ?? 0,
            );
      if (this.isOrdinaryPlaceable(definition)) {
        sprite.setInteractive({ useHandCursor: true });
        sprite.on(
          'pointerdown',
          (
            _pointer: Phaser.Input.Pointer,
            _localX: number,
            _localY: number,
            event: Phaser.Types.Input.EventData,
          ) => {
            event.stopPropagation();
            this.selectPlacedItem(placed.instanceId);
          },
        );
      }
      this.committedSprites.push(sprite);
    }
    this.publishVisualProbeDiagnostics();
  }

  private drawPreview(publishStatus = true): void {
    this.previewGraphics.clear();
    this.previewSprite?.destroy();
    this.previewSprite = null;
    for (const sprite of this.wallpaperPreviewSprites) sprite.destroy();
    this.wallpaperPreviewSprites = [];

    if (this.selectedWallpaperRotation !== null) return;

    const shape = this.currentShape();
    const tile = this.hoverTile;
    if (!shape || !tile) return;

    const validation = this.currentValidation();
    if (!validation) return;

    const line = validation.ok ? 0x74d680 : 0xff6b6b;
    const fill = validation.ok ? 0x74d680 : 0xff6b6b;

    this.previewGraphics.lineStyle(2, line, 1);
    this.previewGraphics.fillStyle(fill, 0.2);
    this.drawTileFootprint(
      this.previewGraphics,
      tile,
      { sizeX: shape.sizeX, sizeY: shape.sizeY },
      true,
    );

    const item = this.currentDefinition();
    const visual = item ? this.itemVisual(item) : null;
    if (item?.placementFootprint && visual && this.isAuthoritativeWallpaper(item)) {
      const targetRotation = defaultWallAttachmentRotation(tile, this.room);
      if (
        validation.ok &&
        (targetRotation === 0 || targetRotation === 1)
      ) {
        this.rotation = targetRotation;
        const tiles: TilePoint[] = [];
        if (targetRotation === 0) {
          for (let y = 1; y < this.room.insideY; y += 1) {
            tiles.push({ x: 0, y });
          }
        } else {
          for (let x = 1; x < this.room.insideX; x += 1) {
            tiles.push({ x, y: 0 });
          }
        }

        for (const wallTile of tiles) {
          const sprite = this.createItemSprite(
            item,
            visual,
            targetRotation,
            wallTile,
            0.72,
          );
          sprite.setDepth(this.itemDrawPriority(wallTile) + 2);
          this.wallpaperPreviewSprites.push(sprite);
        }
      }

      if (publishStatus) {
        this.publishUi(
          validation.ok
            ? `Wallpaper preview targets every ${targetRotation === 0 ? 'left' : 'top'} wall segment.`
            : `Wallpaper preview rejected: ${validation.reason}.`,
          validation,
        );
      }
      return;
    }

    if (item?.placementFootprint && visual) {
      const curHeight = validation.ok
        ? this.previewCurHeight(item, tile, validation.roomIndex)
        : 0;
      this.previewSprite = this.createItemSprite(
        item,
        visual,
        this.rotation,
        tile,
        validation.ok ? 0.72 : 0.36,
        curHeight,
      );
      this.previewSprite.setDepth(this.itemDrawPriority(tile, curHeight) + 1);
    }

    if (publishStatus) {
      this.publishUi(
        validation.ok
          ? 'Placement preview matches current authoritative constraints.'
          : `Placement preview rejected: ${validation.reason}.`,
        validation,
      );
    }
  }

  private drawTileFootprint(
    graphics: Phaser.GameObjects.Graphics,
    tile: TilePoint,
    footprint: Footprint,
    fill: boolean,
  ): void {
    for (let dx = 0; dx < footprint.sizeX; dx += 1) {
      for (let dy = 0; dy < footprint.sizeY; dy += 1) {
        const x = tile.x + dx;
        const y = tile.y + dy;
        const corners = [
          projectTile({ x, y }),
          projectTile({ x: x + 1, y }),
          projectTile({ x: x + 1, y: y + 1 }),
          projectTile({ x, y: y + 1 }),
        ];

        graphics.beginPath();
        graphics.moveTo(
          ORIGIN.x + corners[0]!.x,
          ORIGIN.y + corners[0]!.y,
        );
        for (const corner of corners.slice(1)) {
          graphics.lineTo(ORIGIN.x + corner.x, ORIGIN.y + corner.y);
        }
        graphics.closePath();
        if (fill) graphics.fillPath();
        graphics.strokePath();
      }
    }
  }

  private requireAtlasFrameNames(atlasId: string): readonly string[] {
    if (!this.textures.exists(atlasId)) {
      throw new Error(`Required Restaurant City atlas failed to load: ${atlasId}`);
    }
    const frames = this.textures.get(atlasId).getFrameNames();
    if (frames.length === 0) {
      throw new Error(`Required Restaurant City atlas has no frames: ${atlasId}`);
    }
    return frames;
  }

  private itemVisual(
    item: RestaurantItemDefinition,
  ): RestaurantItemVisual | null {
    if (!this.visualIndex) return null;
    return resolveRestaurantItemVisual(item, this.visualIndex);
  }

  private currentVisual(): RestaurantItemVisual | null {
    const item = this.currentDefinition();
    return item ? this.itemVisual(item) : null;
  }

  private itemDrawPriority(tile: TilePoint, curHeight = 0): number {
    // WorldRestaurant: getTileDrawPriority(x,y) + RoomItem.curHeight.
    return (tile.y * 20 + tile.x) * 256 + curHeight;
  }

  private stackGeometryFor(itemId: number) {
    const definition = this.catalogById.get(itemId);
    if (!definition?.placementFootprint) return null;
    return {
      footprint: definition.placementFootprint,
      itemHeightTwips: definition.itemHeightTwips,
    };
  }

  private computeCurHeights(
    items: readonly AuthoritativePlacedItem[],
  ): ReadonlyMap<number, number> {
    return computeHistoricalCurHeights(
      items.map((item) => ({
        instanceId: item.instanceId,
        itemId: item.itemId,
        tileX: item.tileX,
        tileY: item.tileY,
        rotation: item.rotation,
        roomIndex: item.roomIndex,
      })),
      (itemId) => this.stackGeometryFor(itemId),
    );
  }

  private previewCurHeight(
    item: RestaurantItemDefinition,
    tile: TilePoint,
    roomIndex: number,
  ): number {
    const instanceId =
      this.selectedPlacedInstanceId ?? Number.MAX_SAFE_INTEGER;
    const ordered = this.authoritativeItems
      .filter((placed) => placed.instanceId !== this.selectedPlacedInstanceId)
      .concat({
        instanceId,
        itemId: item.id,
        tileX: tile.x,
        tileY: tile.y,
        rotation: this.rotation,
        roomIndex,
      });
    return this.computeCurHeights(ordered).get(instanceId) ?? 0;
  }

  private createItemSprite(
    definition: RestaurantItemDefinition,
    visual: RestaurantItemVisual,
    rotation: number,
    tile: TilePoint,
    alpha: number,
    curHeight = 0,
  ): Phaser.GameObjects.Sprite {
    if (!definition.placementFootprint) {
      throw new Error(`Item #${definition.id} has no explicit footprint`);
    }

    const frameName = frameForRestaurantItemRotation(visual, rotation);
    const atlasFrame = this.textures.getFrame(visual.atlasId, frameName);
    if (!atlasFrame) {
      throw new Error(
        `Atlas frame missing at render time: ${visual.atlasId}/${frameName}`,
      );
    }

    const footprint = rotateFootprint(definition.placementFootprint, rotation);
    const offset =
      recoveredWallFloorFrameOffset(
        definition.id,
        definition.className,
        rotation,
      ) ??
      recoveredWallpaperFrameOffset(
        definition.id,
        definition.className,
        rotation,
      ) ??
      historicalRoomItemFrameOffset(
        footprint,
        atlasFrame.width,
        atlasFrame.height,
      );
    const projected = projectTile(tile);

    return this.add
      .sprite(
        ORIGIN.x + projected.x + offset.x,
        ORIGIN.y + projected.y + offset.y - curHeight,
        visual.atlasId,
        frameName,
      )
      .setOrigin(0, 0)
      .setAlpha(alpha)
      .setDepth(this.itemDrawPriority(tile, curHeight));
  }

  private publishInitializationError(error: unknown): void {
    const sessionFailure =
      error instanceof RestaurantAuthorityError && error.status === 401;
    gameUiBridge.publish({
      phase: 'error',
      status: sessionFailure
        ? 'ANEWON product session is unavailable or expired. Relaunch Restaurant City from the authenticated ANEWON product origin.'
        : `Restaurant City initialization failed: ${this.describeError(error)}`,
    });
  }

  private describeAuthorityError(error: RestaurantAuthorityError): string {
    if (error.status === 409) {
      return 'Authority rejected the restaurant change because inventory, occupied state, or idempotency state changed. The latest state remains authoritative.';
    }
    if (error.status === 422) {
      return 'Authority rejected the restaurant change under current Restaurant City placement rules.';
    }
    if (error.status === 401) {
      return 'ANEWON product session is unavailable or expired.';
    }
    return this.describeError(error);
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
