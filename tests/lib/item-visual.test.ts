import { describe, expect, it } from 'vitest';
import {
  buildRestaurantItemVisualIndex,
  frameForRestaurantItemRotation,
  historicalRoomItemFrameOffset,
  isSystemOnlyRestaurantItem,
  resolveRestaurantItemVisual,
} from '../../src/content/itemVisual';

const baseItem = {
  id: 10,
  name: 'Chair',
  group: 'Decoration',
  className: 'ChairItem',
  hash: null,
} as const;

describe('Restaurant City item visuals', () => {
  it('resolves an exact className before lower-confidence display-name aliases', () => {
    const index = buildRestaurantItemVisualIndex([
      {
        atlasId: 'indoor_asset',
        frameNames: [
          'indoor_asset/skunkitem/001',
          'indoor_asset/skunkitem/002',
          'indoor_asset/skunk/001',
          'indoor_asset/skunk/002',
          'indoor_asset/skunk/003',
        ],
      },
    ]);

    const visual = resolveRestaurantItemVisual(
      {
        ...baseItem,
        id: 3800007,
        name: 'Skunk',
        group: 'Decoration',
        className: 'SkunkItem',
      },
      index,
    );

    expect(visual).toEqual({
      atlasId: 'indoor_asset',
      symbol: 'skunkitem',
      frames: ['indoor_asset/skunkitem/001', 'indoor_asset/skunkitem/002'],
    });
  });

  it('uses recovered MovieClip frame order as the rotation contract', () => {
    const visual = {
      atlasId: 'indoor_asset',
      symbol: 'cannon',
      frames: [
        'indoor_asset/cannon/001',
        'indoor_asset/cannon/002',
        'indoor_asset/cannon/003',
        'indoor_asset/cannon/004',
      ],
    };

    expect(frameForRestaurantItemRotation(visual, 0)).toBe(
      'indoor_asset/cannon/001',
    );
    expect(frameForRestaurantItemRotation(visual, 3)).toBe(
      'indoor_asset/cannon/004',
    );
    expect(() => frameForRestaurantItemRotation(visual, 4)).toThrow(
      /invalid.*4 historical frame/i,
    );
  });

  it('rejects a third rotation for a two-frame historical RoomItem', () => {
    const visual = {
      atlasId: 'indoor_asset',
      symbol: 'fishtanksmall',
      frames: [
        'indoor_asset/fishtanksmall/001',
        'indoor_asset/fishtanksmall/002',
      ],
    };

    expect(frameForRestaurantItemRotation(visual, 1)).toBe(
      'indoor_asset/fishtanksmall/002',
    );
    expect(() => frameForRestaurantItemRotation(visual, 2)).toThrow(
      /invalid.*2 historical frame/i,
    );
  });

  it('never exposes visit activities or outside-size configuration as player item visuals', () => {
    expect(isSystemOnlyRestaurantItem({ group: 'Visit' })).toBe(true);
    expect(isSystemOnlyRestaurantItem({ group: 'OutsideAreaSize' })).toBe(true);

    const index = buildRestaurantItemVisualIndex([
      {
        atlasId: 'indoor_asset',
        frameNames: ['indoor_asset/visitfireitem/001'],
      },
    ]);
    expect(
      resolveRestaurantItemVisual(
        {
          ...baseItem,
          id: 3800003,
          name: 'VisitFire',
          group: 'Visit',
          className: 'VisitFireItem',
        },
        index,
      ),
    ).toBeNull();
  });

  it('accepts qualified class names by their leaf symbol name', () => {
    const index = buildRestaurantItemVisualIndex([
      {
        atlasId: 'indoor_asset',
        frameNames: ['indoor_asset/chairitem/001'],
      },
    ]);

    expect(
      resolveRestaurantItemVisual(
        { ...baseItem, className: 'legacy.items::ChairItem' },
        index,
      )?.frames,
    ).toEqual(['indoor_asset/chairitem/001']);
  });

  it('recovers the cropped PNG top-left from the original RoomItem bounds math', () => {
    expect(
      historicalRoomItemFrameOffset(
        { sizeX: 2, sizeY: 1 },
        120,
        100,
      ),
    ).toEqual({ x: -40, y: -40 });
  });

  it('fails closed on malformed atlas frame keys', () => {
    expect(() =>
      buildRestaurantItemVisualIndex([
        { atlasId: 'indoor_asset', frameNames: ['bad-frame'] },
      ]),
    ).toThrow(/Malformed Restaurant City atlas frame key/);
  });
});
