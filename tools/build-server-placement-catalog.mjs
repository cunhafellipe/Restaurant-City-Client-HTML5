import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const GENERATED = path.join(REPO, 'public', 'assets', 'generated');
const ITEM_DB = path.join(GENERATED, 'data', 'restaurant.items.json');
const MANIFEST = path.join(GENERATED, 'manifest.json');
const RECOVERED_GEOMETRY = path.join(
  REPO,
  'contracts',
  'restaurant-city',
  'recovered-room-item-geometry.json',
);
const RECOVERED_WALL_FLOOR_GEOMETRY = path.join(
  REPO,
  'contracts',
  'restaurant-city',
  'recovered-wall-floor-geometry.json',
);
const RECOVERED_WALLPAPER_GEOMETRY = path.join(
  REPO,
  'contracts',
  'restaurant-city',
  'recovered-wallpaper-geometry.json',
);
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
const recoveredGeometry = JSON.parse(fs.readFileSync(RECOVERED_GEOMETRY, 'utf8'));
const recoveredWallFloorGeometry = JSON.parse(
  fs.readFileSync(RECOVERED_WALL_FLOOR_GEOMETRY, 'utf8'),
);
const recoveredWallpaperGeometry = JSON.parse(
  fs.readFileSync(RECOVERED_WALLPAPER_GEOMETRY, 'utf8'),
);
const source = manifest.data?.find((entry) => entry.id === 'restaurant');
const symbolIndex = buildAtlasSymbolIndex(manifest);
if (!source) {
  throw new Error('Runtime manifest has no restaurant data family');
}

function recoveredGeometryFor(itemId, className) {
  const leaf = leafClassName(className);
  if (!leaf) return null;

  const roomItem = recoveredGeometry.classes?.[leaf];
  if (
    roomItem &&
    Array.isArray(roomItem.itemIds) &&
    roomItem.itemIds.includes(itemId)
  ) {
    return { ...roomItem, recoveredGeometrySource: 'room-item' };
  }

  // Wall1 is both historical wall runtime evidence and the canonical first
  // wallpaper class. A disabled wall-floor runtime entry must not shadow an
  // explicitly promoted wallpaper contract for the same item/class pair.
  const wallpaper = recoveredWallpaperGeometry.items?.find(
    (entry) => entry.itemId === itemId && entry.className === leaf,
  );
  if (wallpaper) {
    return {
      itemIds: [itemId],
      footprint: { sizeX: 1, sizeY: 1 },
      serverCatalogEnabled:
        recoveredWallpaperGeometry.serverCatalogEnabled === true,
      recoveredGeometrySource: 'wallpaper',
    };
  }

  const wallFloor = recoveredWallFloorGeometry.classes?.[leaf];
  if (
    wallFloor &&
    Array.isArray(wallFloor.itemIds) &&
    wallFloor.itemIds.includes(itemId)
  ) {
    return { ...wallFloor, recoveredGeometrySource: 'wall-floor' };
  }

  return null;
}

const definitions = [];
const ids = new Map();
let skippedWithoutFootprint = 0;
let skippedInvalidId = 0;
let skippedSystemOnly = 0;
const unresolvedSurfaceDefinitions = [];
const unresolvedStackableDefinitions = [];
const unsupportedDomainInventory = [];

for (const group of database.groups ?? []) {
  for (const item of group.items ?? []) {
    const id = asInteger(item.attributes?.id);
    if (id === null || id < 0) {
      skippedInvalidId += 1;
      continue;
    }

    const explicitSizeX = asInteger(item.attributes?.sizeX);
    const explicitSizeY = asInteger(item.attributes?.sizeY);
    const geometry = recoveredGeometryFor(id, item.attributes?.className);
    const recoveredFootprint =
      geometry?.placementFootprintEnabled === true ||
      geometry?.serverCatalogEnabled === true
        ? geometry.footprint
        : null;
    const sizeX =
      explicitSizeX !== null && explicitSizeX > 0
        ? explicitSizeX
        : asInteger(recoveredFootprint?.sizeX);
    const sizeY =
      explicitSizeY !== null && explicitSizeY > 0
        ? explicitSizeY
        : asInteger(recoveredFootprint?.sizeY);
    const footprintSource =
      explicitSizeX !== null &&
      explicitSizeX > 0 &&
      explicitSizeY !== null &&
      explicitSizeY > 0
        ? 'explicit'
        : sizeX !== null && sizeY !== null
          ? 'recovered'
          : null;
    const surface = hasFlag(group, item, 'surface');
    const stackable = hasFlag(group, item, 'stackable');
    const wallItem = hasFlag(group, item, 'wallItem');
    const wallDecorationItem = hasFlag(group, item, 'wallDecorationItem');
    const wallpaperItem = hasFlag(group, item, 'wallpaperItem');
    const floorTileItem = hasFlag(group, item, 'floorTileItem');
    const doorItem = hasFlag(group, item, 'doorItem');
    const wallDivider = hasFlag(group, item, 'wallDivider');
    const systemOnly = SYSTEM_ONLY_GROUPS.has(group.name);

    if (
      !systemOnly &&
      (wallItem ||
        wallDecorationItem ||
        wallpaperItem ||
        floorTileItem ||
        doorItem ||
        wallDivider)
    ) {
      unsupportedDomainInventory.push({
        itemId: id,
        group: group.name,
        name:
          typeof item.attributes?.name === 'string'
            ? item.attributes.name
            : null,
        className:
          typeof item.attributes?.className === 'string'
            ? item.attributes.className
            : null,
        explicitSizeX,
        explicitSizeY,
        recoveredSizeX: asInteger(recoveredFootprint?.sizeX),
        recoveredSizeY: asInteger(recoveredFootprint?.sizeY),
        footprintSource,
        wallItem,
        wallDecorationItem,
        wallpaperItem,
        floorTileItem,
        doorItem,
        wallDivider,
        rotationCount:
          typeof item.attributes?.className === 'string'
            ? (() => {
                try {
                  return resolveRotationCount(symbolIndex, item, group.name);
                } catch {
                  return null;
                }
              })()
            : null,
      });
    }

    if (sizeX === null || sizeY === null || sizeX <= 0 || sizeY <= 0) {
      skippedWithoutFootprint += 1;
      if (!systemOnly && (surface || stackable)) {
        const unresolved = {
          itemId: id,
          group: group.name,
          className:
            typeof item.attributes?.className === 'string'
              ? item.attributes.className
              : null,
          hasSizeX: explicitSizeX !== null && explicitSizeX > 0,
          hasSizeY: explicitSizeY !== null && explicitSizeY > 0,
        };
        if (surface) unresolvedSurfaceDefinitions.push(unresolved);
        if (stackable) unresolvedStackableDefinitions.push(unresolved);
      }
      continue;
    }

    if (systemOnly) {
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
      group: group.name,
      name:
        typeof item.attributes?.name === 'string'
          ? item.attributes.name
          : null,
      className:
        typeof item.attributes?.className === 'string'
          ? item.attributes.className
          : null,
      sizeX,
      sizeY,
      footprintSource,
      recoveredGeometrySource: geometry?.recoveredGeometrySource ?? null,
      rotationCount: resolveRotationCount(symbolIndex, item, group.name),
      wallItem,
      wallDecorationItem,
      wallpaperItem,
      outdoor: hasFlag(group, item, 'outdoor'),
      floorTileItem,
      surface,
      stackable,
      wallDivider,
    });
  }
}

definitions.sort((a, b) => a.itemId - b.itemId);

const promotedDividerIds = new Set(
  Object.values(recoveredGeometry.classes ?? {})
    .filter(
      (entry) =>
        entry?.placementFootprintEnabled === true &&
        Array.isArray(entry?.effectiveTypes) &&
        entry.effectiveTypes.includes('wallDivider'),
    )
    .flatMap((entry) => entry.itemIds ?? []),
);
if (promotedDividerIds.size > 0) {
  const trustedDividerIds = new Set(
    definitions
      .filter(
        (entry) =>
          promotedDividerIds.has(entry.itemId) &&
          entry.wallDivider === true &&
          entry.wallItem === false &&
          entry.wallDecorationItem === false &&
          entry.wallpaperItem === false &&
          entry.recoveredGeometrySource === 'room-item',
      )
      .map((entry) => entry.itemId),
  );
  const missingDividerIds = [...promotedDividerIds]
    .filter((itemId) => !trustedDividerIds.has(itemId))
    .sort((a, b) => a - b);
  if (
    promotedDividerIds.size !== 5 ||
    trustedDividerIds.size !== promotedDividerIds.size ||
    missingDividerIds.length !== 0
  ) {
    throw new Error(
      `Promoted wallDivider catalog coverage mismatch: contract=${promotedDividerIds.size} trusted=${trustedDividerIds.size} missing=${missingDividerIds.join(',') || '<none>'}`,
    );
  }
}

if (recoveredWallpaperGeometry.serverCatalogEnabled === true) {
  const promotedWallpaperIds = new Set(
    (recoveredWallpaperGeometry.items ?? []).map((entry) => entry.itemId),
  );
  const trustedWallpapers = definitions.filter(
    (entry) =>
      promotedWallpaperIds.has(entry.itemId) &&
      entry.wallpaperItem === true &&
      entry.recoveredGeometrySource === 'wallpaper',
  );
  const trustedWallpaperIds = new Set(
    trustedWallpapers.map((entry) => entry.itemId),
  );
  const missingWallpaperIds = [...promotedWallpaperIds]
    .filter((itemId) => !trustedWallpaperIds.has(itemId))
    .sort((a, b) => a - b);
  if (
    promotedWallpaperIds.size !== 48 ||
    trustedWallpaperIds.size !== promotedWallpaperIds.size ||
    missingWallpaperIds.length !== 0
  ) {
    throw new Error(
      `Promoted wallpaper catalog coverage mismatch: contract=${promotedWallpaperIds.size} trusted=${trustedWallpaperIds.size} missing=${missingWallpaperIds.join(',') || '<none>'}`,
    );
  }
}

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
  format: 'ANEWON_RC_PLACEMENT_CATALOG_V3',
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
  definitionSources: definitions.map((entry) => ({
    itemId: entry.itemId,
    group: entry.group,
    name: entry.name,
    className: entry.className,
    sizeX: entry.sizeX,
    sizeY: entry.sizeY,
    footprintSource: entry.footprintSource,
    recoveredGeometrySource: entry.recoveredGeometrySource,
    surface: entry.surface,
    stackable: entry.stackable,
    wallDivider: entry.wallDivider,
  })),
  recoveredFootprintDefinitions: definitions.filter(
    (entry) => entry.footprintSource === 'recovered',
  ).length,
  recoveredGeometryContracts: [
    path.relative(REPO, RECOVERED_GEOMETRY),
    path.relative(REPO, RECOVERED_WALL_FLOOR_GEOMETRY),
    path.relative(REPO, RECOVERED_WALLPAPER_GEOMETRY),
  ],
  unsupportedDomainCounts: {
    total: unsupportedDomainInventory.length,
    wallItem: unsupportedDomainInventory.filter((entry) => entry.wallItem).length,
    wallDecorationItem: unsupportedDomainInventory.filter(
      (entry) => entry.wallDecorationItem,
    ).length,
    wallpaperItem: unsupportedDomainInventory.filter(
      (entry) => entry.wallpaperItem,
    ).length,
    floorTileItem: unsupportedDomainInventory.filter(
      (entry) => entry.floorTileItem,
    ).length,
    doorItem: unsupportedDomainInventory.filter((entry) => entry.doorItem).length,
    wallDivider: unsupportedDomainInventory.filter(
      (entry) => entry.wallDivider,
    ).length,
  },
  unsupportedDomainInventory,
  unresolvedSurfaceDefinitions,
  unresolvedStackableDefinitions,
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
