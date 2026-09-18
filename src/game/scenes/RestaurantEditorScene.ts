import Phaser from 'phaser';
import {
  footprintsOverlap,
  projectTile,
  rotateFootprint,
  screenToTileIndex,
  validateStructuralPlacement,
  type Footprint,
  type PlacementShape,
  type RoomDimensions,
  type TilePoint,
} from '../../core/restaurantGrid';
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
  loadGeneratedItemDatabase,
  loadRuntimeManifest,
} from '../../content/runtime';
import {
  createPlacementMutationId,
  createRemoveMutationId,
  createTransformMutationId,
  RestaurantAuthorityError,
  type AuthoritativeInventoryAvailability,
  type AuthoritativePlacedItem,
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

type EditorPlacementValidation =
  | ReturnType<typeof validateStructuralPlacement>
  | {
      readonly ok: false;
      readonly reason: 'occupied' | 'unavailable' | 'authority-desynced';
    };

export class RestaurantEditorScene extends Phaser.Scene {
  private floorGraphics!: Phaser.GameObjects.Graphics;
  private committedGraphics!: Phaser.GameObjects.Graphics;
  private previewGraphics!: Phaser.GameObjects.Graphics;
  private committedSprites: Phaser.GameObjects.Sprite[] = [];
  private previewSprite: Phaser.GameObjects.Sprite | null = null;
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

  private room: RoomDimensions = INITIAL_ROOM;
  private selectedIndex = 0;
  private rotation = 0;
  private hoverTile: TilePoint | null = null;
  private authorityLoaded = false;
  private authoritySynchronized = false;
  private placementInFlight = false;
  private selectedPlacedInstanceId: number | null = null;

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
    this.floorGraphics.lineStyle(1, 0x6f8b96, 0.75);

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
      if (this.placementInFlight) return;
      const maxRotations = this.currentVisual()?.frames.length ?? 1;
      this.rotation = (this.rotation + 1) % maxRotations;
      this.refreshSelectedItem();
      this.drawPreview();
    };

    this.input.keyboard?.on('keydown-R', rotate);
    this.input.keyboard?.on('keydown-LEFT', () => this.selectRelative(-1));
    this.input.keyboard?.on('keydown-RIGHT', () => this.selectRelative(1));
    this.input.keyboard?.on('keydown-ESC', () => this.cancelPlacedEdit());
    this.input.keyboard?.on('keydown-DELETE', () => {
      void this.removeSelectedPlacedItem();
    });
    this.input.keyboard?.on('keydown-BACKSPACE', () => {
      void this.removeSelectedPlacedItem();
    });

    this.unsubscribeCommands = gameUiBridge.subscribeCommands((command) => {
      if (command === 'previous-item') this.selectRelative(-1);
      else if (command === 'next-item') this.selectRelative(1);
      else if (command === 'rotate-item') rotate();
      else if (command === 'remove-selected') {
        void this.removeSelectedPlacedItem();
      } else if (command === 'cancel-edit') {
        this.cancelPlacedEdit();
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
      this.candidates = catalog.filter((item) => this.isOrdinaryPlaceable(item));

      for (const item of this.candidates) {
        if (!this.itemVisual(item)) {
          throw new Error(
            `Player-placeable Restaurant City item #${item.id} (${item.name}) has no exact runtime atlas visual`,
          );
        }
      }

      if (this.candidates.length === 0) {
        throw new Error(
          'restaurant ItemDatabase contains no ordinary item with an explicit historical footprint',
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
          `Loaded baseline ${manifest.baseline} and ${layout.items.length} persisted restaurant item(s).`,
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

    for (const placed of layout.items) {
      const definition = this.catalogById.get(placed.itemId);
      if (!definition || !this.isOrdinaryPlaceable(definition)) {
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

    this.drawFloor();
    this.drawCommittedPlacements();
    this.refreshSelectedItem();
  }

  private isOrdinaryPlaceable(item: RestaurantItemDefinition): boolean {
    const footprint = item.explicitFootprint;
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
      this.selectedPlacedInstanceId !== null
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
    });
  }

  private selectedItemUi(): GameUiState['selectedItem'] {
    const item = this.candidates[this.selectedIndex];
    if (!item?.explicitFootprint) return undefined;

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
      footprint: `${item.explicitFootprint.sizeX}×${item.explicitFootprint.sizeY}`,
      rotation: this.rotation,
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

  private currentDefinition(): RestaurantItemDefinition | null {
    const placed = this.selectedPlacedItem();
    if (placed) return this.catalogById.get(placed.itemId) ?? null;
    return this.candidates[this.selectedIndex] ?? null;
  }

  private selectPlacedItem(instanceId: number): void {
    if (this.placementInFlight || !this.authoritySynchronized) return;
    const placed = this.authoritativeItems.find(
      (item) => item.instanceId === instanceId,
    );
    if (!placed) return;

    this.selectedPlacedInstanceId = placed.instanceId;
    this.rotation = placed.rotation;
    this.hoverTile = { x: placed.tileX, y: placed.tileY };
    this.drawCommittedPlacements();
    this.drawPreview(false);
    this.publishUi(
      `Editing placed #${placed.instanceId}. Hover a destination and click the floor to save; Rotate changes the preview.`,
      this.currentValidation(),
    );
  }

  private cancelPlacedEdit(): void {
    if (this.placementInFlight || this.selectedPlacedInstanceId === null) return;
    const instanceId = this.selectedPlacedInstanceId;
    this.selectedPlacedInstanceId = null;
    this.rotation = 0;
    this.drawCommittedPlacements();
    this.drawPreview(false);
    this.publishUi(
      `Cancelled edit for placed #${instanceId}. No authoritative state was changed.`,
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
    if (!item?.explicitFootprint) return null;
    const footprint = rotateFootprint(item.explicitFootprint, this.rotation);
    return { ...footprint, ...item.placement };
  }

  private currentValidation(): EditorPlacementValidation | null {
    const shape = this.currentShape();
    const tile = this.hoverTile;
    const item = this.currentDefinition();
    if (!shape || !tile || !item) return null;

    if (this.authorityLoaded && !this.authoritySynchronized) {
      return { ok: false, reason: 'authority-desynced' };
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
    tile: TilePoint,
    shape: PlacementShape,
    roomIndex: number,
    excludeInstanceId: number | null = null,
  ): boolean {
    return this.authoritativeItems.some((placed) => {
      if (
        placed.instanceId === excludeInstanceId ||
        placed.roomIndex !== roomIndex
      ) {
        return false;
      }

      const definition = this.catalogById.get(placed.itemId);
      if (!definition?.explicitFootprint) return true;

      const footprint = rotateFootprint(
        definition.explicitFootprint,
        placed.rotation,
      );
      return footprintsOverlap(
        tile,
        { sizeX: shape.sizeX, sizeY: shape.sizeY },
        { x: placed.tileX, y: placed.tileY },
        footprint,
      );
    });
  }

  private async commitCurrentMutation(): Promise<void> {
    if (this.selectedPlacedInstanceId !== null) {
      await this.commitSelectedTransform();
      return;
    }
    await this.commitCurrentPlacement();
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
    if (!item || !validation?.ok) {
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
        `Authoritative state resynchronized: ${layout.items.length} persisted item(s).`,
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

  private drawCommittedPlacements(): void {
    this.committedGraphics.clear();
    for (const sprite of this.committedSprites) sprite.destroy();
    this.committedSprites = [];

    for (const placed of this.authoritativeItems) {
      const definition = this.catalogById.get(placed.itemId);
      if (!definition?.explicitFootprint) continue;

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
        rotateFootprint(definition.explicitFootprint, placed.rotation),
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
          rotateFootprint(definition.explicitFootprint, placed.rotation),
          true,
        );
      }

      const sprite = this.createItemSprite(
        definition,
        visual,
        placed.rotation,
        { x: placed.tileX, y: placed.tileY },
        selected ? 0.35 : 1,
      );
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
      this.committedSprites.push(sprite);
    }
  }

  private drawPreview(publishStatus = true): void {
    this.previewGraphics.clear();
    this.previewSprite?.destroy();
    this.previewSprite = null;
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
    if (item?.explicitFootprint && visual) {
      this.previewSprite = this.createItemSprite(
        item,
        visual,
        this.rotation,
        tile,
        validation.ok ? 0.72 : 0.36,
      );
      this.previewSprite.setDepth(this.itemDrawPriority(tile) + 1);
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

  private itemDrawPriority(tile: TilePoint): number {
    // WorldRestaurant.getTileDrawPriority(x,y) = (y * 20 + x) << 8.
    return (tile.y * 20 + tile.x) * 256;
  }

  private createItemSprite(
    definition: RestaurantItemDefinition,
    visual: RestaurantItemVisual,
    rotation: number,
    tile: TilePoint,
    alpha: number,
  ): Phaser.GameObjects.Sprite {
    if (!definition.explicitFootprint) {
      throw new Error(`Item #${definition.id} has no explicit footprint`);
    }

    const frameName = frameForRestaurantItemRotation(visual, rotation);
    const atlasFrame = this.textures.getFrame(visual.atlasId, frameName);
    if (!atlasFrame) {
      throw new Error(
        `Atlas frame missing at render time: ${visual.atlasId}/${frameName}`,
      );
    }

    const footprint = rotateFootprint(definition.explicitFootprint, rotation);
    const offset = historicalRoomItemFrameOffset(
      footprint,
      atlasFrame.width,
      atlasFrame.height,
    );
    const projected = projectTile(tile);

    return this.add
      .sprite(
        ORIGIN.x + projected.x + offset.x,
        ORIGIN.y + projected.y + offset.y,
        visual.atlasId,
        frameName,
      )
      .setOrigin(0, 0)
      .setAlpha(alpha)
      .setDepth(this.itemDrawPriority(tile));
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
