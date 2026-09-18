import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const GENERATED = path.join(REPO, 'public', 'assets', 'generated');
const MANIFEST_FILE = path.join(GENERATED, 'manifest.json');
const SERVER_CATALOG = path.join(
  REPO,
  'server',
  'runtime',
  'generated',
  'restaurant-placement-catalog.tsv',
);
const OUT_DIR = path.join(HERE, '.work', 'item-asset-mapping');
const REPORT = path.join(OUT_DIR, 'report.json');

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  return null;
}

function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalize(value) {
  return String(value ?? '').trim().toLowerCase();
}

function requireFile(file, label) {
  if (!fs.existsSync(file)) {
    throw new Error(label + ' missing: ' + file);
  }
}

function parseAuthoritativeIds(text) {
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex((line) => line.startsWith('item_id\t'));
  if (header < 0) throw new Error('trusted placement catalog has no TSV header');

  const ids = new Set();
  for (const raw of lines.slice(header + 1)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const id = Number.parseInt(line.split('\t', 1)[0], 10);
    if (!Number.isInteger(id) || id < 0 || ids.has(id)) {
      throw new Error('invalid/duplicate authoritative placement id: ' + line);
    }
    ids.add(id);
  }
  return ids;
}

function symbolFromFrameKey(key) {
  const parts = String(key).split('/');
  if (parts.length < 3 || !parts[0] || !parts[1]) {
    throw new Error('malformed atlas frame key: ' + key);
  }
  return { atlasId: parts[0], symbol: parts[1] };
}

function buildSymbolIndex(manifest) {
  const bySymbol = new Map();
  let frameCount = 0;

  for (const atlas of manifest.atlases ?? []) {
    if (!isObject(atlas) || typeof atlas.id !== 'string' || typeof atlas.json !== 'string') {
      throw new Error('malformed atlas manifest entry');
    }

    const atlasFile = path.join(GENERATED, atlas.json);
    requireFile(atlasFile, 'atlas ' + atlas.id);
    const value = JSON.parse(fs.readFileSync(atlasFile, 'utf8'));
    if (!Array.isArray(value.textures)) {
      throw new Error('atlas ' + atlas.id + ' has no textures array');
    }

    for (const texture of value.textures) {
      if (!Array.isArray(texture.frames)) {
        throw new Error('atlas ' + atlas.id + ' texture has no frames');
      }
      for (const frame of texture.frames) {
        const parsed = symbolFromFrameKey(frame.filename);
        frameCount += 1;
        const symbol = normalize(parsed.symbol);
        if (!bySymbol.has(symbol)) bySymbol.set(symbol, new Map());
        const atlasMap = bySymbol.get(symbol);
        if (!atlasMap.has(atlas.id)) atlasMap.set(atlas.id, new Set());
        atlasMap.get(atlas.id).add(frame.filename);
      }
    }
  }

  return { bySymbol, frameCount };
}

function exactMatches(index, value) {
  const key = normalize(value);
  if (!key) return [];
  const atlasMap = index.get(key);
  if (!atlasMap) return [];
  return [...atlasMap.entries()]
    .map(([atlasId, frames]) => ({
      atlasId,
      symbol: key,
      frames: [...frames].sort(),
    }))
    .sort((a, b) => a.atlasId.localeCompare(b.atlasId));
}

function leafClassName(value) {
  if (!value) return null;
  const parts = String(value).split(/[.:]/);
  return parts.at(-1) || null;
}

requireFile(MANIFEST_FILE, 'runtime manifest');
requireFile(SERVER_CATALOG, 'trusted placement catalog');

const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
if (manifest.version !== 3) throw new Error('item asset mapping requires manifest v3');

const restaurant = (manifest.data ?? []).find((entry) => entry.id === 'restaurant');
if (!restaurant?.itemDatabase) {
  throw new Error('restaurant ItemDatabase missing from runtime manifest');
}
const itemDbFile = path.join(GENERATED, restaurant.itemDatabase);
requireFile(itemDbFile, 'restaurant ItemDatabase');
const database = JSON.parse(fs.readFileSync(itemDbFile, 'utf8'));
if (!Array.isArray(database.groups)) throw new Error('malformed restaurant ItemDatabase');

const authoritativeIds = parseAuthoritativeIds(fs.readFileSync(SERVER_CATALOG, 'utf8'));
const { bySymbol, frameCount } = buildSymbolIndex(manifest);

const records = [];
for (const group of database.groups) {
  for (const item of group.items ?? []) {
    const id = integer(item.attributes?.id);
    if (id === null || !authoritativeIds.has(id)) continue;

    const sizeX = integer(item.attributes?.sizeX);
    const sizeY = integer(item.attributes?.sizeY);
    if (sizeX === null || sizeY === null || sizeX <= 0 || sizeY <= 0) continue;

    const className = stringValue(item.attributes?.className);
    const hash = stringValue(item.attributes?.hash);
    const itemName = stringValue(item.attributes?.name);

    const strategies = [
      { strategy: 'className', value: className },
      { strategy: 'classNameLeaf', value: leafClassName(className) },
      { strategy: 'hash', value: hash },
      { strategy: 'name', value: itemName },
    ];

    const candidates = [];
    for (const candidate of strategies) {
      for (const match of exactMatches(bySymbol, candidate.value)) {
        const candidateKey = match.atlasId + '/' + match.symbol;
        if (!candidates.some((entry) => entry.key === candidateKey)) {
          candidates.push({
            key: candidateKey,
            strategy: candidate.strategy,
            atlasId: match.atlasId,
            symbol: match.symbol,
            frameCount: match.frames.length,
            frames: match.frames,
          });
        }
      }
    }

    records.push({
      itemId: id,
      group: group.name,
      itemName,
      className,
      hash,
      candidates,
      classification:
        candidates.length === 1
          ? 'unique'
          : candidates.length === 0
            ? 'missing'
            : 'ambiguous',
    });
  }
}

records.sort((a, b) => a.itemId - b.itemId);
const seenIds = new Set();
for (const record of records) {
  if (seenIds.has(record.itemId)) {
    throw new Error(
      'authoritative item id ' + record.itemId + ' resolved to multiple ItemDatabase records',
    );
  }
  seenIds.add(record.itemId);
}
for (const id of authoritativeIds) {
  if (!seenIds.has(id)) {
    throw new Error('authoritative item id ' + id + ' not found in restaurant ItemDatabase');
  }
}

const counts = {
  authoritativeItems: authoritativeIds.size,
  records: records.length,
  unique: records.filter((record) => record.classification === 'unique').length,
  ambiguous: records.filter((record) => record.classification === 'ambiguous').length,
  missing: records.filter((record) => record.classification === 'missing').length,
  atlasSymbols: bySymbol.size,
  atlasFrames: frameCount,
};

const strategyCounts = {};
for (const record of records) {
  if (record.classification !== 'unique') continue;
  const strategy = record.candidates[0].strategy;
  strategyCounts[strategy] = (strategyCounts[strategy] ?? 0) + 1;
}

const report = {
  schemaVersion: 1,
  baseline: manifest.baseline,
  counts,
  uniqueStrategyCounts: strategyCounts,
  records,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');

console.log(
  'item-asset mapping: authoritative=' + counts.authoritativeItems +
    ' unique=' + counts.unique +
    ' ambiguous=' + counts.ambiguous +
    ' missing=' + counts.missing +
    ' atlasSymbols=' + counts.atlasSymbols +
    ' atlasFrames=' + counts.atlasFrames,
);
console.log('item-asset mapping report: ' + REPORT);
