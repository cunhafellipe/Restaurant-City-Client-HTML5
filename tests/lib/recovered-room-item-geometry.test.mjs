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
    for (const key of ['Table', 'WhiteTable1x1']) {
      const entry = contract.classes[key];
      expect(derive(entry.boundsTwips)).toEqual({
        ...entry.footprint,
        itemHeightTwips: entry.itemHeightTwips,
      });
      expect(entry.placementFootprintEnabled).toBe(true);
    }
  });

  it('keeps ViolinCase itemHeight pinned to constructor frame 1 across rotations', () => {
    const violin = contract.classes.ViolinCase;
    expect(derive(violin.frame1BoundsTwips)).toEqual({
      ...violin.footprint,
      itemHeightTwips: 439,
    });
    expect(violin.constructorFrame).toBe(1);
    expect(violin.rotationCount).toBe(4);
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

  it('promotes only source-grounded recovered footprints while keeping all others fail-closed', () => {
    expect(contract.releasePolicy).toMatch(
      /all other implicit-footprint items remain fail-closed/i,
    );
    expect(
      Object.values(contract.classes)
        .filter((entry) => entry.placementFootprintEnabled === true)
        .flatMap((entry) => entry.itemIds)
        .sort((a, b) => a - b),
    ).toEqual([
      3020049,
      3020050,
      3020051,
      3020052,
      3020055,
      3030000,
      3030002,
      3070000,
      3070001,
      3070002,
      3070003,
      3070004,
      3070005,
      3070006,
      3070007,
      3070008,
      3070009,
      3070010,
    ]);
  });

  it('pins all eleven kitchen composites to exact four-rotation occupied-cell contracts', () => {
    const kitchenEntries = Object.values(contract.classes).filter(
      (entry) =>
        entry.composite === true &&
        entry.effectiveTypes?.includes('kitchen'),
    );
    expect(kitchenEntries).toHaveLength(11);

    const expectedCells = [
      [{ x: 0, y: 0 }, { x: 1, y: 0 }],
      [{ x: 0, y: 0 }, { x: 0, y: 1 }],
      [{ x: 0, y: 0 }, { x: -1, y: 0 }],
      [{ x: 0, y: 0 }, { x: 0, y: -1 }],
    ];

    for (const entry of kitchenEntries) {
      expect(entry.footprint).toEqual({ sizeX: 2, sizeY: 1 });
      expect(entry.rotationCount).toBe(4);
      expect(entry.frames).toHaveLength(4);
      expect(entry.occupiedCellsByRotation).toHaveLength(4);
      expect(
        entry.occupiedCellsByRotation.map((rotation) => rotation.cells),
      ).toEqual(expectedCells);
    }

    const stove10 = contract.classes.Stove10;
    expect(stove10.visualFrameCount).toBe(1);
    expect(new Set(stove10.frames.map((frame) => frame.frame)).size).toBe(1);

    const stove11 = contract.classes.Stove11;
    expect(stove11.runtimeClassName).toBe('Stove11Rotations_485');
    expect(stove11.visualFrameCount).toBe(4);
  });
});
