import Phaser from 'phaser';
import {
  projectTile,
  rotateFootprint,
  screenToTileIndex,
  validateStructuralPlacement,
  type PlacementShape,
  type RoomDimensions,
  type TilePoint,
} from '../../core/restaurantGrid';
import {
  buildRestaurantItemCatalog,
  type RestaurantItemDefinition,
} from '../../content/items';
import {
  loadGeneratedItemDatabase,
  loadRuntimeManifest,
} from '../../content/runtime';

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

export class RestaurantEditorScene extends Phaser.Scene {
  private readonly floorGraphics!: Phaser.GameObjects.Graphics;
  private readonly previewGraphics!: Phaser.GameObjects.Graphics;
  private statusText!: Phaser.GameObjects.Text;
  private itemText!: Phaser.GameObjects.Text;
  private candidates: readonly RestaurantItemDefinition[] = [];
  private selectedIndex = 0;
  private rotation = 0;
  private hoverTile: TilePoint | null = null;

  constructor() {
    super('RestaurantEditor');
  }

  create(): void {
    this.cameras.main.setBackgroundColor(0x1c2b33);

    this.add
      .text(16, 14, 'ANEWON Restaurant City — M2 world/editor', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '20px',
        color: '#ffffff',
      });

    this.add
      .text(16, 40, 'Historical level-0 room: 8×8 · R rotate · ←/→ item', {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#a9c7d5',
      });

    this.floorGraphics = this.add.graphics();
    this.previewGraphics = this.add.graphics();
    this.statusText = this.add.text(16, 548, 'Loading generated Restaurant City data…', {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#c8c8c8',
      wordWrap: { width: 728 },
    });
    this.itemText = this.add.text(16, 520, 'No item selected', {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#ffffff',
    });

    this.drawFloor();
    this.bindInput();
    void this.loadHistoricalCatalog();
  }

  private drawFloor(): void {
    this.floorGraphics.clear();
    this.floorGraphics.lineStyle(1, 0x6f8b96, 0.75);

    for (let x = 0; x < INITIAL_ROOM.insideX; x += 1) {
      for (let y = 0; y < INITIAL_ROOM.insideY; y += 1) {
        const corners = [
          projectTile({ x, y }),
          projectTile({ x: x + 1, y }),
          projectTile({ x: x + 1, y: y + 1 }),
          projectTile({ x, y: y + 1 }),
        ];
        this.floorGraphics.beginPath();
        this.floorGraphics.moveTo(ORIGIN.x + corners[0]!.x, ORIGIN.y + corners[0]!.y);
        for (const corner of corners.slice(1)) {
          this.floorGraphics.lineTo(ORIGIN.x + corner.x, ORIGIN.y + corner.y);
        }
        this.floorGraphics.closePath();
        this.floorGraphics.strokePath();
      }
    }
  }

  private bindInput(): void {
    this.input.on(Phaser.Input.Events.POINTER_MOVE, (pointer: Phaser.Input.Pointer) => {
      this.hoverTile = screenToTileIndex({
        x: pointer.x - ORIGIN.x,
        y: pointer.y - ORIGIN.y,
      });
      this.drawPreview();
    });

    this.input.keyboard?.on('keydown-R', () => {
      this.rotation = (this.rotation + 1) % 4;
      this.drawPreview();
    });
    this.input.keyboard?.on('keydown-LEFT', () => this.selectRelative(-1));
    this.input.keyboard?.on('keydown-RIGHT', () => this.selectRelative(1));

    this.input.on(Phaser.Input.Events.POINTER_DOWN, () => {
      if (!this.hoverTile || this.candidates.length === 0) return;
      const validation = this.currentValidation();
      if (!validation?.ok) return;
      this.statusText.setText(
        'Placement preview is valid. Persistence is intentionally blocked until the authoritative placement command is wired.',
      );
    });
  }

  private async loadHistoricalCatalog(): Promise<void> {
    try {
      const manifest = await loadRuntimeManifest();
      const database = await loadGeneratedItemDatabase(manifest, 'restaurant');
      const catalog = buildRestaurantItemCatalog(database);

      this.candidates = catalog.filter((item) => {
        const footprint = item.explicitFootprint;
        return (
          footprint !== null &&
          footprint.sizeX > 0 &&
          footprint.sizeY > 0 &&
          !item.placement.wallItem &&
          !item.placement.wallDecorationItem &&
          !item.placement.wallpaperItem &&
          !item.placement.outdoor &&
          !item.placement.floorTileItem
        );
      });

      if (this.candidates.length === 0) {
        throw new Error(
          'restaurant ItemDatabase contains no ordinary item with an explicit historical footprint',
        );
      }

      this.selectedIndex = 0;
      this.rotation = 0;
      this.refreshSelectedItem();
      this.statusText.setText(
        `Loaded baseline ${manifest.baseline}: ${catalog.length} restaurant records; ${this.candidates.length} structurally placeable with explicit footprints.`,
      );
      this.drawPreview();
    } catch (error) {
      this.statusText.setText(
        `Generated content unavailable: ${error instanceof Error ? error.message : String(error)}. Run npm run hydrate:local after R16.`,
      );
    }
  }

  private selectRelative(delta: number): void {
    if (this.candidates.length === 0) return;
    this.selectedIndex =
      (this.selectedIndex + delta + this.candidates.length) %
      this.candidates.length;
    this.rotation = 0;
    this.refreshSelectedItem();
    this.drawPreview();
  }

  private refreshSelectedItem(): void {
    const item = this.candidates[this.selectedIndex];
    if (!item || !item.explicitFootprint) {
      this.itemText.setText('No item selected');
      return;
    }
    this.itemText.setText(
      `item #${item.id} ${item.name} · group=${item.group} · footprint=${item.explicitFootprint.sizeX}×${item.explicitFootprint.sizeY} · rotation=${this.rotation}`,
    );
  }

  private currentShape(): PlacementShape | null {
    const item = this.candidates[this.selectedIndex];
    if (!item?.explicitFootprint) return null;
    const footprint = rotateFootprint(item.explicitFootprint, this.rotation);
    return { ...footprint, ...item.placement };
  }

  private currentValidation() {
    const shape = this.currentShape();
    if (!shape || !this.hoverTile) return null;
    return validateStructuralPlacement(shape, this.hoverTile, INITIAL_ROOM);
  }

  private drawPreview(): void {
    this.previewGraphics.clear();
    const shape = this.currentShape();
    const tile = this.hoverTile;
    if (!shape || !tile) return;

    const validation = validateStructuralPlacement(shape, tile, INITIAL_ROOM);
    const line = validation.ok ? 0x74d680 : 0xff6b6b;
    const fill = validation.ok ? 0x74d680 : 0xff6b6b;

    this.previewGraphics.lineStyle(2, line, 1);
    this.previewGraphics.fillStyle(fill, 0.2);

    for (let dx = 0; dx < shape.sizeX; dx += 1) {
      for (let dy = 0; dy < shape.sizeY; dy += 1) {
        const x = tile.x + dx;
        const y = tile.y + dy;
        const corners = [
          projectTile({ x, y }),
          projectTile({ x: x + 1, y }),
          projectTile({ x: x + 1, y: y + 1 }),
          projectTile({ x, y: y + 1 }),
        ];
        this.previewGraphics.beginPath();
        this.previewGraphics.moveTo(
          ORIGIN.x + corners[0]!.x,
          ORIGIN.y + corners[0]!.y,
        );
        for (const corner of corners.slice(1)) {
          this.previewGraphics.lineTo(ORIGIN.x + corner.x, ORIGIN.y + corner.y);
        }
        this.previewGraphics.closePath();
        this.previewGraphics.fillPath();
        this.previewGraphics.strokePath();
      }
    }

    this.refreshSelectedItem();
    this.statusText.setText(
      validation.ok
        ? `tile=(${tile.x},${tile.y}) valid · roomIndex=${validation.roomIndex}`
        : `tile=(${tile.x},${tile.y}) invalid · ${validation.reason}`,
    );
  }
}
