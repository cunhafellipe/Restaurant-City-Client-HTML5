import { describe, expect, it } from 'vitest';
import {
  recoveredPlacementFootprint,
  recoveredRoomItemFrame,
  recoveredRoomItemFrameOffset,
  recoveredRoomItemGeometry,
} from '../../src/content/recoveredRoomItemGeometry';

describe('recovered RoomItem geometry lookup', () => {
  it('promotes only exact item-id/class pairs for Table surfaces', () => {
    expect(recoveredPlacementFootprint(3030000, 'Table')).toEqual({
      sizeX: 1,
      sizeY: 1,
    });
    expect(recoveredPlacementFootprint(3030002, 'WhiteTable1x1')).toEqual({
      sizeX: 1,
      sizeY: 1,
    });
    expect(recoveredPlacementFootprint(3030000, 'WhiteTable1x1')).toBeNull();
    expect(recoveredPlacementFootprint(3030001, 'Table')).toBeNull();
  });

  it('uses recovered ViolinCase height without overriding its explicit footprint', () => {
    const geometry = recoveredRoomItemGeometry(3020179, 'ViolinCase');
    expect(geometry?.itemHeightTwips).toBe(439);
    expect(geometry?.placementFootprintEnabled).toBe(false);
    expect(recoveredPlacementFootprint(3020179, 'ViolinCase')).toBeNull();
  });

  it('promotes all five canonical wallDivider families only after frozen physical validation', () => {
    const expected = [
      [3020049, 'WhiteWall', 2, 2328],
      [3020050, 'WhiteWallCorner', 4, 2334],
      [3020051, 'WhiteWallCross', 1, 2340],
      [3020052, 'WhiteWallT', 4, 2340],
      [3020055, 'JapaneseLamp', 1, 1742],
    ] as const;

    let frames = 0;
    for (const [itemId, className, rotations, itemHeightTwips] of expected) {
      const geometry = recoveredRoomItemGeometry(itemId, className);
      expect(geometry?.footprint).toEqual({ sizeX: 1, sizeY: 1 });
      expect(geometry?.itemHeightTwips).toBe(itemHeightTwips);
      expect(geometry?.frames).toHaveLength(rotations);
      expect(geometry?.placementFootprintEnabled).toBe(true);
      expect(recoveredPlacementFootprint(itemId, className)).toEqual({
        sizeX: 1,
        sizeY: 1,
      });
      for (let rotation = 0; rotation < rotations; rotation += 1) {
        expect(recoveredRoomItemFrame(itemId, className, rotation)?.rotation).toBe(
          rotation,
        );
        expect(
          recoveredRoomItemFrameOffset(itemId, className, rotation),
        ).not.toBeNull();
        frames += 1;
      }
    }
    expect(frames).toBe(12);
  });

  it('accepts qualified historical class names by exact leaf plus item id', () => {
    expect(recoveredPlacementFootprint(3030000, 'legacy.items::Table')).toEqual({
      sizeX: 1,
      sizeY: 1,
    });
  });
});
