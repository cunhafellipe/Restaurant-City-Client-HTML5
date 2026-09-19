import { describe, expect, it } from 'vitest';
import {
  buildRestaurantItemCatalog,
  buildRestaurantItemDefinition,
  findRestaurantItemsById,
} from '../../src/content/items';
import type {
  GeneratedItem,
  GeneratedItemGroup,
} from '../../src/content/runtime';

const group: GeneratedItemGroup = {
  name: 'furniture',
  attributes: {
    name: 'furniture',
    type: ['decorItem'],
  },
  items: [],
};

function item(
  attributes: GeneratedItem['attributes'],
): GeneratedItem {
  return { group: group.name, attributes, childrenXml: '' };
}

describe('Restaurant City runtime item definitions', () => {
  it('keeps AS3 group types and item types additive', () => {
    const definition = buildRestaurantItemDefinition(
      { ...group, attributes: { name: 'furniture', type: ['outdoor'] } },
      item({
        id: '12',
        name: 'table',
        type: ['surface', 'stackable'],
        sizeX: '2',
        sizeY: '1',
        cost: '250',
      }),
    );

    expect(definition.types).toEqual(['outdoor', 'surface', 'stackable']);
    expect(definition.placement.outdoor).toBe(true);
    expect(definition.stackable).toBe(true);
    expect(definition.surface).toBe(true);
    expect(definition.explicitFootprint).toEqual({ sizeX: 2, sizeY: 1 });
    expect(definition.cost).toBe(250);
  });

  it('does not invent a footprint when the historical XML omits it', () => {
    const definition = buildRestaurantItemDefinition(
      group,
      item({ id: '4', name: 'derived_by_visual_bounds' }),
    );
    expect(definition.explicitFootprint).toBeNull();
  });

  it('keeps canonical wallDivider as ordinary decor after recovered placement promotion', () => {
    const definition = buildRestaurantItemDefinition(
      {
        ...group,
        attributes: {
          name: 'Decoration',
          type: ['decorItem'],
        },
      },
      item({
        id: '3020049',
        name: 'White Wall',
        className: 'WhiteWall',
        type: ['wallDivider'],
      }),
    );

    expect(definition.types).toEqual(['decorItem', 'wallDivider']);
    expect(definition.placement.wallItem).toBe(false);
    expect(definition.placement.wallDecorationItem).toBe(false);
    expect(definition.placement.wallpaperItem).toBe(false);
    expect(definition.explicitFootprint).toBeNull();
    expect(definition.placementFootprint).toEqual({ sizeX: 1, sizeY: 1 });
    expect(definition.footprintSource).toBe('recovered');
  });

  it('preserves duplicate ids like the original loader', () => {
    const db = {
      schemaVersion: 1 as const,
      groups: [
        {
          ...group,
          items: [
            item({ id: '1', name: 'a' }),
            item({ id: '1', name: 'b' }),
          ],
        },
      ],
      counts: { groups: 1, items: 2 },
    };
    const catalog = buildRestaurantItemCatalog(db);
    expect(findRestaurantItemsById(catalog, 1).map((entry) => entry.name)).toEqual([
      'a',
      'b',
    ]);
  });
});
