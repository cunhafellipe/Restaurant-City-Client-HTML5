import { describe, expect, it } from 'vitest';
import {
  recoveredDoorMaskRaster,
  recoveredWallFloorFrameOffset,
  recoveredWallFloorGeometry,
} from '../../src/content/recoveredWallFloorGeometry';

describe('recovered wall/floor geometry contract', () => {
  it('enables Simple Door only with the proven 1x1 two-rotation contract', () => {
    const door = recoveredWallFloorGeometry(3010000, 'Door');
    expect(door).not.toBeNull();
    expect(door?.serverCatalogEnabled).toBe(true);
    expect(door?.runtimeGeometryEnabled).toBe(true);
    expect(door?.footprint).toEqual({ sizeX: 1, sizeY: 1 });
    expect(door?.rotationFrames.map((frame) => frame.frame)).toEqual([
      'indoor_asset/door/001',
      'indoor_asset/door/002',
    ]);
  });

  it('pins the DoorWayMask raster and both recovered canvas origins', () => {
    expect(recoveredDoorMaskRaster(3010000, 'Door')).toMatchObject({
      frame: 'indoor_asset/doorwaymask/001',
      canvasOriginPx: { x: 0, y: -75.1 },
      atlasSize: { width: 40, height: 115 },
    });
    expect(recoveredWallFloorFrameOffset(3010000, 'Door', 0)).toEqual({
      x: -86,
      y: -75.25,
    });
    expect(recoveredWallFloorFrameOffset(3010000, 'Door', 1)).toEqual({
      x: -42.9,
      y: -75.25,
    });
  });

  it('fails closed for a mismatched item/class pair', () => {
    expect(recoveredWallFloorGeometry(3010000, 'WindowInside')).toBeNull();
    expect(recoveredDoorMaskRaster(3000001, 'Door')).toBeNull();
  });
});
