import type {
  GeneratedItem,
  GeneratedItemDatabase,
  GeneratedItemGroup,
  LegacyAttributeValue,
} from './runtime';
import type { Footprint, PlacementShape } from '../core/restaurantGrid';

export interface RestaurantItemDefinition {
  readonly id: number;
  readonly name: string;
  readonly group: string;
  readonly className: string | null;
  readonly hash: string | null;
  readonly cost: number;
  readonly cash: number;
  readonly types: readonly string[];
  readonly explicitFootprint: Footprint | null;
  readonly placement: Omit<PlacementShape, keyof Footprint>;
  readonly stackable: boolean;
  readonly surface: boolean;
  readonly raw: GeneratedItem;
}

function stringValue(
  attrs: Readonly<Record<string, LegacyAttributeValue>>,
  key: string,
): string | null {
  const value = attrs[key];
  return typeof value === 'string' ? value : null;
}

function integerValue(
  attrs: Readonly<Record<string, LegacyAttributeValue>>,
  key: string,
  fallback?: number,
): number | null {
  const value = attrs[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  return fallback ?? null;
}

function booleanValue(
  attrs: Readonly<Record<string, LegacyAttributeValue>>,
  key: string,
): boolean {
  return attrs[key] === true;
}

function typesOf(
  attrs: Readonly<Record<string, LegacyAttributeValue>>,
): readonly string[] {
  const value = attrs.type;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function requireId(item: GeneratedItem): number {
  const id = integerValue(item.attributes, 'id');
  if (id === null || id < 0) {
    throw new Error(
      `Restaurant City item ${stringValue(item.attributes, 'name') ?? '<unnamed>'} has invalid id`,
    );
  }
  return id;
}

function requireName(item: GeneratedItem): string {
  const name = stringValue(item.attributes, 'name');
  if (!name) {
    throw new Error(`Restaurant City item id=${requireId(item)} has no name`);
  }
  return name;
}

function explicitFootprint(item: GeneratedItem): Footprint | null {
  const sizeX = integerValue(item.attributes, 'sizeX');
  const sizeY = integerValue(item.attributes, 'sizeY');
  if (sizeX === null && sizeY === null) return null;
  if (sizeX === null || sizeY === null || sizeX < 0 || sizeY < 0) {
    throw new Error(
      `Restaurant City item ${requireName(item)} has incomplete footprint`,
    );
  }
  return { sizeX, sizeY };
}

function effectiveTypes(
  group: GeneratedItemGroup,
  item: GeneratedItem,
): readonly string[] {
  return [...new Set([...typesOf(group.attributes), ...typesOf(item.attributes)])];
}

function hasType(types: readonly string[], type: string): boolean {
  return types.includes(type);
}

export function buildRestaurantItemDefinition(
  group: GeneratedItemGroup,
  item: GeneratedItem,
): RestaurantItemDefinition {
  const types = effectiveTypes(group, item);
  return {
    id: requireId(item),
    name: requireName(item),
    group: group.name,
    className: stringValue(item.attributes, 'className'),
    hash: stringValue(item.attributes, 'hash'),
    cost: integerValue(item.attributes, 'cost', 0) ?? 0,
    cash: integerValue(item.attributes, 'cash', 0) ?? 0,
    types,
    explicitFootprint: explicitFootprint(item),
    placement: {
      wallItem: hasType(types, 'wallItem') || booleanValue(item.attributes, 'wallItem'),
      wallDecorationItem:
        hasType(types, 'wallDecorationItem') ||
        booleanValue(item.attributes, 'wallDecorationItem'),
      wallpaperItem:
        hasType(types, 'wallpaperItem') ||
        booleanValue(item.attributes, 'wallpaperItem'),
      outdoor: hasType(types, 'outdoor') || booleanValue(item.attributes, 'outdoor'),
      floorTileItem:
        hasType(types, 'floorTileItem') ||
        booleanValue(item.attributes, 'floorTileItem'),
    },
    stackable: hasType(types, 'stackable') || booleanValue(item.attributes, 'stackable'),
    surface: hasType(types, 'surface') || booleanValue(item.attributes, 'surface'),
    raw: item,
  };
}

export function buildRestaurantItemCatalog(
  database: GeneratedItemDatabase,
): readonly RestaurantItemDefinition[] {
  const items = database.groups.flatMap((group) =>
    group.items.map((item) => buildRestaurantItemDefinition(group, item)),
  );

  // The original client warns about duplicate ids rather than rejecting them.
  // Preserve them here; callers needing a unique lookup must disambiguate by
  // group/name rather than silently dropping historical entries.
  return items;
}

export function findRestaurantItemsById(
  catalog: readonly RestaurantItemDefinition[],
  id: number,
): readonly RestaurantItemDefinition[] {
  return catalog.filter((item) => item.id === id);
}
