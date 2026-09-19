import { describe, expect, it } from 'vitest';
import { recoveredChairOverlayRotation } from '../../src/content/recoveredChairOverlay';

describe('recovered chair overlay presentation', () => {
  it('preserves historically empty Chair01 overlay rotations', () => {
    expect(recoveredChairOverlayRotation(3040000, 'Chair01', 0)).toEqual({
      rotation: 0,
      visible: false,
      frame: null,
      canvasOriginPx: null,
    });
    expect(recoveredChairOverlayRotation(3040000, 'Chair01', 1)).toEqual({
      rotation: 1,
      visible: false,
      frame: null,
      canvasOriginPx: null,
    });
  });

  it('pins visible Chair01 overlay rotations to R49 atlas origins', () => {
    expect(recoveredChairOverlayRotation(3040000, 'Chair01', 2)).toEqual({
      rotation: 2,
      visible: true,
      frame: 'indoor_asset/chair01overlay/003',
      canvasOriginPx: { x: -22.6, y: -23.25 },
    });
    expect(recoveredChairOverlayRotation(3040000, 'Chair01', 3)).toEqual({
      rotation: 3,
      visible: true,
      frame: 'indoor_asset/chair01overlay/004',
      canvasOriginPx: { x: -22.8, y: -23 },
    });
  });

  it('returns null for a chair without a recovered overlay contract', () => {
    expect(recoveredChairOverlayRotation(9999999, 'UnknownChair', 0)).toBeNull();
  });

  it('fails closed on an invalid logical rotation', () => {
    expect(() =>
      recoveredChairOverlayRotation(3040000, 'Chair01', 4),
    ).toThrow(/no logical rotation 4/);
  });
});
