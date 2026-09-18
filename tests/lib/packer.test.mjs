import { describe, expect, it } from 'vitest';
import { packFramePages, packFrames } from '../../tools/lib/packer.mjs';

describe('packFrames', () => {
  it('places every frame once, inside the atlas bounds', () => {
    const frames = [
      { key: 'a', w: 10, h: 20 },
      { key: 'b', w: 30, h: 10 },
      { key: 'c', w: 5, h: 5 },
      { key: 'd', w: 40, h: 40 },
    ];
    const { width, height, placements } = packFrames(frames);
    expect(placements).toHaveLength(4);
    expect(new Set(placements.map((p) => p.key)).size).toBe(4);
    for (const p of placements) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x + p.w).toBeLessThanOrEqual(width);
      expect(p.y + p.h).toBeLessThanOrEqual(height);
    }
  });

  it('never overlaps placed frames', () => {
    const frames = Array.from({ length: 50 }, (_, i) => ({
      key: `f${i}`,
      w: (i % 7) + 1,
      h: (i % 11) + 1,
    }));
    const { placements } = packFrames(frames);
    for (let i = 0; i < placements.length; i++) {
      for (let j = i + 1; j < placements.length; j++) {
        const a = placements[i];
        const b = placements[j];
        const overlap =
          a.x < b.x + b.w &&
          a.x + a.w > b.x &&
          a.y < b.y + b.h &&
          a.y + a.h > b.y;
        expect(overlap, `overlap between ${a.key} and ${b.key}`).toBe(false);
      }
    }
  });

  it('is deterministic for identical input', () => {
    const frames = [
      { key: 'x', w: 12, h: 8 },
      { key: 'y', w: 8, h: 12 },
    ];
    expect(packFrames(frames)).toEqual(packFrames([...frames]));
  });

  it('respects maxWidth by wrapping to new rows', () => {
    const frames = [
      { key: 'a', w: 100, h: 10 },
      { key: 'b', w: 100, h: 10 },
      { key: 'c', w: 100, h: 10 },
    ];
    const { width, height, placements } = packFrames(frames, { maxWidth: 250 });
    expect(width).toBeLessThanOrEqual(250);
    const byKey = Object.fromEntries(placements.map((p) => [p.key, p]));
    expect(byKey.c.y).toBeGreaterThanOrEqual(byKey.a.y + byKey.a.h + 4);
    expect(height).toBeGreaterThan(10);
  });
});

describe('packFramePages', () => {
  it('splits large corpora into deterministic bounded pages', () => {
    const frames = Array.from({ length: 20 }, (_, i) => ({
      key: `p${String(i).padStart(2, '0')}`,
      w: 96,
      h: 96,
    }));

    const a = packFramePages(frames, {
      maxWidth: 220,
      maxHeight: 220,
      padding: 2,
    });
    const b = packFramePages([...frames], {
      maxWidth: 220,
      maxHeight: 220,
      padding: 2,
    });

    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(1);
    const keys = a.flatMap((page) => page.placements.map((p) => p.key));
    expect(keys).toHaveLength(frames.length);
    expect(new Set(keys).size).toBe(frames.length);

    for (const page of a) {
      expect(page.width).toBeLessThanOrEqual(220);
      expect(page.height).toBeLessThanOrEqual(220);
    }
  });

  it('fails when a single padded frame cannot fit a page', () => {
    expect(() =>
      packFramePages([{ key: 'huge', w: 500, h: 10 }], {
        maxWidth: 256,
        maxHeight: 256,
      }),
    ).toThrow(/exceeds atlas page/);
  });
});
