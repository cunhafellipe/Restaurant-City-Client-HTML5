import { rotateFootprint, type Footprint } from './restaurantGrid';

export interface HistoricalStackGeometry {
  readonly footprint: Footprint;
  readonly itemHeightTwips: number | null;
}

export interface HistoricalStackPlacedItem {
  readonly instanceId: number;
  readonly itemId: number;
  readonly tileX: number;
  readonly tileY: number;
  readonly rotation: number;
  readonly roomIndex: number;
}

function tileKey(roomIndex: number, x: number, y: number): string {
  return `${roomIndex}:${x}:${y}`;
}

function as3Int(value: number): number {
  return Math.trunc(value);
}

/**
 * Rebuilds RoomItem.curHeight from authoritative bottom->top itemMap order.
 *
 * WorldRestaurant.getTileTopHeight() returns int even though getTopHeight()
 * returns Number, so each support height is truncated toward zero exactly
 * where the recovered ActionScript does it.
 */
export function computeHistoricalCurHeights(
  items: readonly HistoricalStackPlacedItem[],
  geometryFor: (itemId: number) => HistoricalStackGeometry | null,
): ReadonlyMap<number, number> {
  const topByTile = new Map<
    string,
    { readonly instanceId: number; readonly topHeight: number | null }
  >();
  const result = new Map<number, number>();

  for (const item of items) {
    const geometry = geometryFor(item.itemId);
    if (!geometry) {
      throw new Error(
        `Missing placement geometry for authoritative item #${item.itemId}`,
      );
    }

    const footprint = rotateFootprint(geometry.footprint, item.rotation);
    let curHeight = 0;

    for (let dx = 0; dx < footprint.sizeX; dx += 1) {
      for (let dy = 0; dy < footprint.sizeY; dy += 1) {
        const top = topByTile.get(
          tileKey(item.roomIndex, item.tileX + dx, item.tileY + dy),
        );
        if (!top) continue;
        if (top.topHeight === null) {
          throw new Error(
            `Cannot derive stack height above item #${top.instanceId} without recovered itemHeight`,
          );
        }
        curHeight = Math.max(curHeight, top.topHeight);
      }
    }

    result.set(item.instanceId, curHeight);
    const topHeight =
      geometry.itemHeightTwips === null
        ? null
        : as3Int(curHeight + geometry.itemHeightTwips / 20);

    for (let dx = 0; dx < footprint.sizeX; dx += 1) {
      for (let dy = 0; dy < footprint.sizeY; dy += 1) {
        topByTile.set(
          tileKey(item.roomIndex, item.tileX + dx, item.tileY + dy),
          { instanceId: item.instanceId, topHeight },
        );
      }
    }
  }

  return result;
}
