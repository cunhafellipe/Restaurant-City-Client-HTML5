import { describe, expect, it } from 'vitest';
import { computeHistoricalCurHeights } from '../../src/core/restaurantStacking';

describe('historical curHeight reconstruction', () => {
  const geometry = new Map([
    [3030000, { footprint: { sizeX: 1, sizeY: 1 }, itemHeightTwips: 510 }],
    [3030002, { footprint: { sizeX: 1, sizeY: 1 }, itemHeightTwips: 524 }],
    [3020179, { footprint: { sizeX: 1, sizeY: 1 }, itemHeightTwips: 439 }],
  ]);

  it('truncates support height exactly at getTileTopHeight int boundary', () => {
    const heights = computeHistoricalCurHeights(
      [
        { instanceId: 1, itemId: 3030000, tileX: 2, tileY: 2, rotation: 0, roomIndex: 0 },
        { instanceId: 2, itemId: 3020179, tileX: 2, tileY: 2, rotation: 0, roomIndex: 0 },
      ],
      (id) => geometry.get(id) ?? null,
    );
    expect(heights.get(1)).toBe(0);
    expect(heights.get(2)).toBe(25);
  });

  it('uses 26px curHeight for WhiteTable1x1 26.2px support', () => {
    const heights = computeHistoricalCurHeights(
      [
        { instanceId: 3, itemId: 3030002, tileX: 3, tileY: 3, rotation: 0, roomIndex: 0 },
        { instanceId: 4, itemId: 3020179, tileX: 3, tileY: 3, rotation: 3, roomIndex: 0 },
      ],
      (id) => geometry.get(id) ?? null,
    );
    expect(heights.get(4)).toBe(26);
  });

  it('fails closed when an occupied support has unknown itemHeight', () => {
    expect(() =>
      computeHistoricalCurHeights(
        [
          { instanceId: 1, itemId: 9, tileX: 2, tileY: 2, rotation: 0, roomIndex: 0 },
          { instanceId: 2, itemId: 10, tileX: 2, tileY: 2, rotation: 0, roomIndex: 0 },
        ],
        (id) => ({ footprint: { sizeX: 1, sizeY: 1 }, itemHeightTwips: id === 9 ? null : 100 }),
      ),
    ).toThrow(/without recovered itemHeight/);
  });
});
