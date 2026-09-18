import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const contract = JSON.parse(
  fs.readFileSync(
    path.resolve('contracts/restaurant-city/recovered-room-item-geometry.json'),
    'utf8',
  ),
);

function as3RoundPositive(value) {
  return Math.floor(value + 0.5);
}

function derive(bounds) {
  const right = bounds.xmax / 20;
  const top = bounds.ymin / 20;
  const bottom = bounds.ymax / 20;
  const sizeX = Math.max(1, as3RoundPositive(right / 40));
  const sizeY = Math.max(1, as3RoundPositive(bottom / 20) - sizeX);
  const itemHeightTwips = Math.round(
    (-top + (40 * sizeY - bottom)) * 20,
  );
  return { sizeX, sizeY, itemHeightTwips };
}

describe('recovered RoomItem geometry contract', () => {
  it('reproduces Table and WhiteTable1x1 using the original constructor math', () => {
    for (const entry of Object.values(contract.classes)) {
      expect(derive(entry.boundsTwips)).toEqual({
        ...entry.footprint,
        itemHeightTwips: entry.itemHeightTwips,
      });
    }
  });

  it('reproduces WhiteTable1x2 sub1 tile offset from its timeline translation', () => {
    const sub1 = contract.composites.WhiteTable1x2.subitems[1];
    const x = sub1.translateTwips.x / 20;
    const y = sub1.translateTwips.y / 20;
    expect({
      x: Math.trunc((x + 2 * y) / 80),
      y: Math.trunc((2 * y - x) / 80),
    }).toEqual(sub1.tileOffset);
  });

  it('keeps implicit surfaces gated until vertical stack rendering is authoritative', () => {
    expect(contract.releasePolicy).toMatch(/do not enable stacked placement/i);
  });
});
