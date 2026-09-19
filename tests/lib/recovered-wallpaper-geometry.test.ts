import { describe, expect, it } from 'vitest';
import {
  recoveredWallpaperFrame,
  recoveredWallpaperFrameOffset,
  recoveredWallpaperGeometry,
  recoveredEnabledWallpaperFootprint,
  recoveredWallpaperItemIds,
  wallpaperServerCatalogEnabled,
} from '../../src/content/recoveredWallpaperGeometry';

describe('recovered wallpaper geometry contract', () => {
  it('covers all 48 canonical wallpaper items exactly once', () => {
    const ids = recoveredWallpaperItemIds();
    expect(ids).toHaveLength(48);
    expect(new Set(ids).size).toBe(48);
    expect(Math.min(...ids)).toBe(3060000);
    expect(Math.max(...ids)).toBe(3060047);
  });

  it('promotes the recovered wallpaper family through the trusted footprint gate', () => {
    expect(wallpaperServerCatalogEnabled()).toBe(true);
    expect(recoveredEnabledWallpaperFootprint(3060000, 'Wall1')).toEqual({
      sizeX: 1,
      sizeY: 1,
    });
    expect(recoveredEnabledWallpaperFootprint(3060000, 'Wall49')).toBeNull();
  });

  it('pins Green Wallpaper to the two recovered Wall1 frames', () => {
    const geometry = recoveredWallpaperGeometry(3060000, 'Wall1');
    expect(geometry?.spriteId).toBe(729);
    expect(geometry?.frames).toEqual([
      {
        rotation: 0,
        frame: 'indoor_asset/wall1/001',
        canvasOriginPx: { x: -40, y: -97 },
      },
      {
        rotation: 1,
        frame: 'indoor_asset/wall1/002',
        canvasOriginPx: { x: -40, y: -97 },
      },
    ]);
  });

  it('retains non-generic recovered origins instead of normalizing them', () => {
    expect(recoveredWallpaperFrameOffset(3060041, 'Wall43', 0)).toEqual({
      x: -39.95,
      y: -93.9,
    });
    expect(recoveredWallpaperFrameOffset(3060044, 'Wall46', 0)).toEqual({
      x: -40.05,
      y: -96.95,
    });
    expect(recoveredWallpaperFrameOffset(3060044, 'Wall46', 1)).toEqual({
      x: 0,
      y: -96.95,
    });
    expect(recoveredWallpaperFrame(3060047, 'Wall49', 1)?.frame).toBe(
      'indoor_asset/wall49/002',
    );
  });

  it('fails closed for mismatched class, item or rotation', () => {
    expect(recoveredWallpaperGeometry(3060000, 'Wall49')).toBeNull();
    expect(recoveredWallpaperGeometry(9999999, 'Wall1')).toBeNull();
    expect(recoveredWallpaperFrame(3060000, 'Wall1', 2)).toBeNull();
  });
});
