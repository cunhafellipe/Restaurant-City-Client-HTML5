import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const GENERATED = path.join(REPO, 'public', 'assets', 'generated');
const ITEM_DB = path.join(GENERATED, 'data', 'restaurant.items.json');
const MANIFEST = path.join(GENERATED, 'manifest.json');
const OUT_DIR = path.join(REPO, 'server', 'runtime', 'generated');
const OUT_TSV = path.join(OUT_DIR, 'restaurant-placement-catalog.tsv');
const OUT_META = path.join(OUT_DIR, 'restaurant-placement-catalog.meta.json');

function asInteger(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  return null;
}

function typesOf(attributes) {
  return Array.isArray(attributes?.type)
    ? attributes.type.filter((value) => typeof value === 'string')
    : [];
}

function hasFlag(group, item, name) {
  const types = new Set([
    ...typesOf(group.attributes),
    ...typesOf(item.attributes),
  ]);
  return types.has(name) || item.attributes?.[name] === true;
}

if (!fs.existsSync(ITEM_DB) || !fs.existsSync(MANIFEST)) {
  throw new Error(
    'Generated canonical runtime data is missing. Run npm run hydrate:local first.',
  );
}

const database = JSON.parse(fs.readFileSync(ITEM_DB, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const source = manifest.data?.find((entry) => entry.id === 'restaurant');
if (!source) {
  throw new Error('Runtime manifest has no restaurant data family');
}

const definitions = [];
const ids = new Map();
let skippedWithoutFootprint = 0;
let skippedInvalidId = 0;

for (const group of database.groups ?? []) {
  for (const item of group.items ?? []) {
    const id = asInteger(item.attributes?.id);
    if (id === null || id < 0) {
      skippedInvalidId += 1;
      continue;
    }

    const sizeX = asInteger(item.attributes?.sizeX);
    const sizeY = asInteger(item.attributes?.sizeY);
    if (sizeX === null || sizeY === null || sizeX <= 0 || sizeY <= 0) {
      skippedWithoutFootprint += 1;
      continue;
    }

    if (ids.has(id)) {
      const previous = ids.get(id);
      throw new Error(
        `Ambiguous placement item_id ${id}: ${previous} and ${group.name}/${item.attributes?.name ?? '<unnamed>'}`,
      );
    }

    ids.set(id, `${group.name}/${item.attributes?.name ?? '<unnamed>'}`);
    definitions.push({
      itemId: id,
      sizeX,
      sizeY,
      wallItem: hasFlag(group, item, 'wallItem'),
      wallDecorationItem: hasFlag(group, item, 'wallDecorationItem'),
      wallpaperItem: hasFlag(group, item, 'wallpaperItem'),
      outdoor: hasFlag(group, item, 'outdoor'),
      floorTileItem: hasFlag(group, item, 'floorTileItem'),
    });
  }
}

definitions.sort((a, b) => a.itemId - b.itemId);
fs.mkdirSync(OUT_DIR, { recursive: true });

const bool = (value) => (value ? '1' : '0');
const lines = [
  'ANEWON_RC_PLACEMENT_CATALOG_V1',
  `# baseline=${manifest.baseline ?? 'unknown'}`,
  `# source_decoded_sha256=${source.decodedSha256 ?? ''}`,
  `# source_file=${source.source ?? ''}`,
  'item_id\tsize_x\tsize_y\twall_item\twall_decoration_item\twallpaper_item\toutdoor\tfloor_tile_item',
  ...definitions.map((entry) =>
    [
      entry.itemId,
      entry.sizeX,
      entry.sizeY,
      bool(entry.wallItem),
      bool(entry.wallDecorationItem),
      bool(entry.wallpaperItem),
      bool(entry.outdoor),
      bool(entry.floorTileItem),
    ].join('\t'),
  ),
];

fs.writeFileSync(OUT_TSV, `${lines.join('\n')}\n`);

const meta = {
  schemaVersion: 1,
  format: 'ANEWON_RC_PLACEMENT_CATALOG_V1',
  baseline: manifest.baseline ?? null,
  sourceFamily: 'restaurant',
  sourceFile: source.source,
  sourceSha256: source.sourceSha256,
  sourceDecodedSha256: source.decodedSha256,
  definitions: definitions.length,
  skippedWithoutFootprint,
  skippedInvalidId,
  duplicateIds: 0,
  generatedAtBuildTime: true,
  browserRuntimeDependency: false,
};

fs.writeFileSync(OUT_META, `${JSON.stringify(meta, null, 2)}\n`);
console.log(
  `server catalog: ${definitions.length} placement definitions · ` +
    `skipped footprint=${skippedWithoutFootprint} invalidId=${skippedInvalidId} · ` +
    `${path.relative(REPO, OUT_TSV)}`,
);
