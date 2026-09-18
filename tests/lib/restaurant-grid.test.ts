import { describe, expect, it } from 'vitest';
import {
  decodeOwnedItemData,
  encodeOwnedItemData,
  isItemOutOfBounds,
  projectTile,
  rotateFootprint,
  screenToTileFraction,
  screenToTileIndex,
  validateStructuralPlacement,
} from '../../src/core/restaurantGrid';

describe('Restaurant City grid contract', () => {
  const room = {
    insideX: 10,
    insideY: 10,
    outsideX: 8,
    outsideY: 4,
  };

  it('matches the recovered isometric projection', () => {
    expect(projectTile({ x: 3, y: 1 })).toEqual({ x: 80, y: 80 });
    expect(projectTile({ x: 1, y: 3 })).toEqual({ x: -80, y: 80 });
    expect(screenToTileFraction({ x: 80, y: 80 })).toEqual({ x: 3, y: 1 });
    expect(screenToTileIndex({ x: 79, y: 79 })).toEqual({ x: 2, y: 0 });
    expect(screenToTileIndex({ x: -39, y: 19 })).toEqual({ x: 0, y: 0 });
  });

  it('round-trips the historical OwnedItem.data nibbles', () => {
    expect(decodeOwnedItemData(0xa3)).toEqual({
      rotation: 3,
      usageCount: 10,
    });
    expect(encodeOwnedItemData(3, 10)).toBe(0xa3);
  });

  it('swaps footprint axes on odd rotations exactly like RoomItem.rotate', () => {
    expect(rotateFootprint({ sizeX: 3, sizeY: 1 }, 0)).toEqual({
      sizeX: 3,
      sizeY: 1,
    });
    expect(rotateFootprint({ sizeX: 3, sizeY: 1 }, 1)).toEqual({
      sizeX: 1,
      sizeY: 3,
    });
    expect(rotateFootprint({ sizeX: 3, sizeY: 1 }, 2)).toEqual({
      sizeX: 3,
      sizeY: 1,
    });
  });

  it('reserves row and column zero for ordinary room items', () => {
    const item = { sizeX: 1, sizeY: 1 };
    expect(isItemOutOfBounds(item, { x: 0, y: 5 }, room)).toBe(true);
    expect(isItemOutOfBounds(item, { x: 5, y: 0 }, room)).toBe(true);
    expect(isItemOutOfBounds(item, { x: 1, y: 1 }, room)).toBe(false);
  });

  it('allows wall-domain items on the historical zero border', () => {
    const wall = { sizeX: 1, sizeY: 1, wallDecorationItem: true };
    expect(isItemOutOfBounds(wall, { x: 0, y: 0 }, room)).toBe(false);
    expect(isItemOutOfBounds(wall, { x: 10, y: 0 }, room)).toBe(true);
  });

  it('routes valid outside-area placement to room index 1', () => {
    expect(
      validateStructuralPlacement(
        { sizeX: 1, sizeY: 1, outdoor: true },
        { x: 2, y: 10 },
        room,
      ),
    ).toEqual({ ok: true, roomIndex: 1 });
  });

  it('rejects outdoor-only items inside the restaurant', () => {
    expect(
      validateStructuralPlacement(
        { sizeX: 1, sizeY: 1, outdoor: true },
        { x: 2, y: 2 },
        room,
      ),
    ).toEqual({ ok: false, reason: 'wrong-area' });
  });

  it('checks an entire rotated footprint against the room bounds', () => {
    expect(
      isItemOutOfBounds({ sizeX: 3, sizeY: 2 }, { x: 8, y: 2 }, room),
    ).toBe(true);
    expect(
      isItemOutOfBounds({ sizeX: 2, sizeY: 3 }, { x: 8, y: 2 }, room),
    ).toBe(false);
  });
});
