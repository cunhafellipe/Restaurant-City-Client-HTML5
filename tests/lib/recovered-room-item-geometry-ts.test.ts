import { describe, expect, it } from 'vitest';
import {
  recoveredPlacementFootprint,
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

  it('accepts qualified historical class names by exact leaf plus item id', () => {
    expect(recoveredPlacementFootprint(3030000, 'legacy.items::Table')).toEqual({
      sizeX: 1,
      sizeY: 1,
    });
  });
});
