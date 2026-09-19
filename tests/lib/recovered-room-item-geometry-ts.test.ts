import { describe, expect, it } from 'vitest';
import {
  recoveredPlacementFootprint,
  recoveredRoomItemFrame,
  recoveredRoomItemFrameOffset,
  recoveredRoomItemGeometry,
  recoveredRoomItemLogicalRotationCount,
  recoveredRoomItemOccupiedCells,
  recoveredRoomItemRuntimeClassName,
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

  it('projects exact logical rotations and occupied cells for promoted kitchen composites', () => {
    const expected = [
      [3070000, 'Stove01', 'StoveRotations'],
      [3070001, 'Stove02', 'StoveRedRotations'],
      [3070002, 'Stove04', 'StoveRotations4'],
      [3070003, 'Stove5', 'StoveRotations5'],
      [3070004, 'Stove7', 'StoveRotations7'],
      [3070005, 'Stove10', 'StoveRotations10'],
      [3070006, 'Stove03', 'StoveRotations3'],
      [3070007, 'HalloweenStove01', 'HalloweenStoveRotations'],
      [3070008, 'Stove11', 'Stove11Rotations_485'],
      [3070009, 'Stove13', 'Stove13Rotations'],
      [3070010, 'Stove14', 'StoveRotations14'],
    ] as const;

    for (const [itemId, className, runtimeClassName] of expected) {
      expect(recoveredPlacementFootprint(itemId, className)).toEqual({
        sizeX: 2,
        sizeY: 1,
      });
      expect(recoveredRoomItemRuntimeClassName(itemId, className)).toBe(
        runtimeClassName,
      );
      expect(recoveredRoomItemLogicalRotationCount(itemId, className)).toBe(4);
      expect(recoveredRoomItemOccupiedCells(itemId, className, 2)).toEqual([
        { x: 0, y: 0 },
        { x: -1, y: 0 },
      ]);
      expect(recoveredRoomItemOccupiedCells(itemId, className, 3)).toEqual([
        { x: 0, y: 0 },
        { x: 0, y: -1 },
      ]);
    }
  });

  it('accepts qualified historical class names by exact leaf plus item id', () => {
    expect(recoveredPlacementFootprint(3030000, 'legacy.items::Table')).toEqual({
      sizeX: 1,
      sizeY: 1,
    });
  });
});
