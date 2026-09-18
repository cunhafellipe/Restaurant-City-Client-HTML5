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
const SYSTEM_ONLY_GROUPS = new Set(['Visit', 'OutsideAreaSize']);

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

function normalizeSymbol(value) {
  return String(value ?? '').trim().toLowerCase();
}

function leafClassName(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parts = value.split(/[.:]/);
  return parts.at(-1) || null;
}

function buildAtlasSymbolIndex(runtimeManifest) {
  const index = new Map();

  for (const atlasEntry of runtimeManifest.atlases ?? []) {
    if (typeof atlasEntry?.id !== 'string' || typeof atlasEntry?.json !== 'string') {
      throw new Error('Malformed runtime atlas entry while building placement catalog');
    }
    const atlasFile = path.join(GENERATED, atlasEntry.json);
    if (!fs.existsSync(atlasFile)) {
      throw new Error(`Runtime atlas missing while building placement catalog: ${atlasFile}`);
    }
    const atlas = JSON.parse(fs.readFileSync(atlasFile, 'utf8'));
    for (const texture of atlas.textures ?? []) {
      for (const frame of texture.frames ?? []) {
        const parts = String(frame.filename ?? '').split('/');
        if (parts.length < 3 || !parts[1]) {
          throw new Error(`Malformed atlas frame key: ${frame.filename ?? '<missing>'}`);
        }
        const symbol = normalizeSymbol(parts[1]);
        if (!index.has(symbol)) index.set(symbol, new Map());
        const atlasMap = index.get(symbol);
        if (!atlasMap.has(atlasEntry.id)) atlasMap.set(atlasEntry.id, new Set());
        atlasMap.get(atlasEntry.id).add(frame.filename);
      }
    }
  }

  return index;
}

function resolveRotationCount(symbolIndex, item, groupName) {
  const className = item.attributes?.className;
  const target = normalizeSymbol(leafClassName(className));
  if (!target) {
    throw new Error(
      `Player-placeable item ${groupName}/${item.attributes?.name ?? '<unnamed>'} has no className`,
    );
  }

  const atlasMap = symbolIndex.get(target);
  if (!atlasMap || atlasMap.size !== 1) {
    throw new Error(
      `Player-placeable item ${groupName}/${item.attributes?.name ?? '<unnamed>'} className=${className} does not resolve uniquely to a runtime atlas symbol`,
    );
  }

  const frames = [...atlasMap.values()][0];
  const rotationCount = frames.size;
  if (rotationCount < 1 || rotationCount > 16) {
    throw new Error(
      `Player-placeable item ${groupName}/${item.attributes?.name ?? '<unnamed>'} has invalid historical rotation frame count ${rotationCount}`,
    );
  }
  return rotationCount;
}

if (!fs.existsSync(ITEM_DB) || !fs.existsSync(MANIFEST)) {
  throw new Error(
    'Generated canonical runtime data is missing. Run npm run hydrate:local first.',
  );
}

const database = JSON.parse(fs.readFileSync(ITEM_DB, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const source = manifest.data?.find((entry) => entry.id === 'restaurant');
const symbolIndex = buildAtlasSymbolIndex(manifest);
if (!source) {
  throw new Error('Runtime manifest has no restaurant data family');
}

const definitions = [];
const ids = new Map();
let skippedWithoutFootprint = 0;
let skippedInvalidId = 0;
let skippedSystemOnly = 0;

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

    if (SYSTEM_ONLY_GROUPS.has(group.name)) {
      skippedSystemOnly += 1;
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
      rotationCount: resolveRotationCount(symbolIndex, item, group.name),
      wallItem: hasFlag(group, item, 'wallItem'),
      wallDecorationItem: hasFlag(group, item, 'wallDecorationItem'),
      wallpaperItem: hasFlag(group, item, 'wallpaperItem'),
      outdoor: hasFlag(group, item, 'outdoor'),
      floorTileItem: hasFlag(group, item, 'floorTileItem'),
      surface: hasFlag(group, item, 'surface'),
      stackable: hasFlag(group, item, 'stackable'),
    });
  }
}

definitions.sort((a, b) => a.itemId - b.itemId);
fs.mkdirSync(OUT_DIR, { recursive: true });

const bool = (value) => (value ? '1' : '0');
const lines = [
  'ANEWON_RC_PLACEMENT_CATALOG_V3',
  `# baseline=${manifest.baseline ?? 'unknown'}`,
  `# source_decoded_sha256=${source.decodedSha256 ?? ''}`,
  `# source_file=${source.source ?? ''}`,
  'item_id\tsize_x\tsize_y\trotation_count\twall_item\twall_decoration_item\twallpaper_item\toutdoor\tfloor_tile_item\tsurface\tstackable',
  ...definitions.map((entry) =>
    [
      entry.itemId,
      entry.sizeX,
      entry.sizeY,
      entry.rotationCount,
      bool(entry.wallItem),
      bool(entry.wallDecorationItem),
      bool(entry.wallpaperItem),
      bool(entry.outdoor),
      bool(entry.floorTileItem),
      bool(entry.surface),
      bool(entry.stackable),
    ].join('\t'),
  ),
];

fs.writeFileSync(OUT_TSV, `${lines.join('\n')}\n`);

const meta = {
  schemaVersion: 3,
  format: 'ANEWON_RC_PLACEMENT_CATALOG_V2',
  baseline: manifest.baseline ?? null,
  sourceFamily: 'restaurant',
  sourceFile: source.source,
  sourceSha256: source.sourceSha256,
  sourceDecodedSha256: source.decodedSha256,
  definitions: definitions.length,
  skippedWithoutFootprint,
  skippedInvalidId,
  skippedSystemOnly,
  duplicateIds: 0,
  surfaceDefinitions: definitions.filter((entry) => entry.surface).length,
  stackableDefinitions: definitions.filter((entry) => entry.stackable).length,
  surfaceAndStackableDefinitions: definitions.filter(
    (entry) => entry.surface && entry.stackable,
  ).length,
  generatedAtBuildTime: true,
  browserRuntimeDependency: false,
};

fs.writeFileSync(OUT_META, `${JSON.stringify(meta, null, 2)}\n`);
console.log(
  `server catalog: ${definitions.length} player placement definitions · ` +
    `surface=${definitions.filter((entry) => entry.surface).length} ` +
    `stackable=${definitions.filter((entry) => entry.stackable).length} ` +
    `both=${definitions.filter((entry) => entry.surface && entry.stackable).length} · ` +
    `skipped footprint=${skippedWithoutFootprint} systemOnly=${skippedSystemOnly} invalidId=${skippedInvalidId} · ` +
    `${path.relative(REPO, OUT_TSV)}`,
);
