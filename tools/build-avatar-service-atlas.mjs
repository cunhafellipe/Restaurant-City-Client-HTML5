/**
 * Pack deterministic Blender-rendered Restaurant City avatar frames into a
 * Phaser multi-atlas plus a runtime descriptor. This is an offline build tool;
 * the browser never parses Collada/model.bin or executes Blender.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { packFramePages } from './lib/packer.mjs';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) {
    throw new Error(`missing required argument ${name}`);
  }
  return path.resolve(process.argv[index + 1]);
}

const framesRoot = arg('--frames');
const manifestFile = arg('--manifest');
const outDir = arg('--out');

const raw = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
if (raw.schemaVersion !== 1) {
  throw new Error(`unsupported avatar raw manifest schema ${raw.schemaVersion}`);
}
if (raw.sourceViewport?.width !== 760 || raw.sourceViewport?.height !== 600) {
  throw new Error('avatar raw manifest must use recovered 760x600 viewport');
}
if (raw.actorOriginViewport?.x !== 380 || raw.actorOriginViewport?.y !== 300) {
  throw new Error('avatar raw manifest actor origin drifted from viewport center');
}
if (raw.tileHeightHalfPx !== 20) {
  throw new Error('avatar raw manifest tile-height-half must remain 20px');
}

function cropAlpha(source, label) {
  let minX = source.width;
  let minY = source.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const alpha = source.data[(y * source.width + x) * 4 + 3];
      if (alpha === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < minX || maxY < minY) {
    throw new Error(`avatar frame ${label} is fully transparent`);
  }

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const cropped = new PNG({ width, height });
  PNG.bitblt(source, cropped, minX, minY, width, height, 0, 0);
  return { cropped, minX, minY, width, height };
}

const physical = [];
const runtimeFrames = {};

for (const frame of raw.frames ?? []) {
  const sourceFile = path.join(framesRoot, frame.file);
  if (!fs.existsSync(sourceFile)) {
    throw new Error(`missing Blender avatar frame ${sourceFile}`);
  }
  const source = PNG.sync.read(fs.readFileSync(sourceFile));
  if (
    source.width !== raw.sourceViewport.width ||
    source.height !== raw.sourceViewport.height
  ) {
    throw new Error(
      `avatar frame ${frame.key} has ${source.width}x${source.height}; expected 760x600`,
    );
  }

  const crop = cropAlpha(source, frame.key);
  const anchorX = raw.actorOriginViewport.x - crop.minX;
  const anchorY =
    raw.actorOriginViewport.y - raw.tileHeightHalfPx - crop.minY;

  physical.push({
    key: frame.key,
    w: crop.width,
    h: crop.height,
    png: crop.cropped,
  });
  runtimeFrames[frame.key] = {
    animation: frame.animation,
    animationId: frame.animationId,
    physicalDirection: frame.physicalDirection,
    historicalFrame: frame.historicalFrame,
    blenderFrame: frame.blenderFrame,
    crop: {
      x: crop.minX,
      y: crop.minY,
      width: crop.width,
      height: crop.height,
    },
    anchorPx: { x: anchorX, y: anchorY },
  };
}

physical.sort((a, b) => a.key.localeCompare(b.key));
if (physical.length !== 98) {
  throw new Error(
    `expected exactly 98 recovered physical avatar frames; got ${physical.length}`,
  );
}

const pages = packFramePages(physical, {
  maxWidth: 2048,
  maxHeight: 2048,
  padding: 2,
});
fs.mkdirSync(outDir, { recursive: true });

for (const file of fs.readdirSync(outDir)) {
  if (
    file === 'restaurant-avatar-placeholder.json' ||
    file === 'restaurant-avatar-placeholder.runtime.json' ||
    file === 'restaurant-avatar-placeholder.png' ||
    (/^restaurant-avatar-placeholder-\d+\.png$/).test(file)
  ) {
    fs.rmSync(path.join(outDir, file), { force: true });
  }
}

const byKey = new Map(physical.map((frame) => [frame.key, frame]));
const textures = [];
const pngFiles = [];

pages.forEach((page, pageIndex) => {
  const pngName =
    pages.length === 1
      ? 'restaurant-avatar-placeholder.png'
      : `restaurant-avatar-placeholder-${pageIndex}.png`;
  const atlas = new PNG({ width: page.width, height: page.height });
  const frames = [];

  for (const placement of page.placements) {
    const source = byKey.get(placement.key);
    if (!source) throw new Error(`missing packed avatar frame ${placement.key}`);
    PNG.bitblt(
      source.png,
      atlas,
      0,
      0,
      source.w,
      source.h,
      placement.x,
      placement.y,
    );
    frames.push({
      filename: source.key,
      rotated: false,
      trimmed: false,
      frame: {
        x: placement.x,
        y: placement.y,
        w: placement.w,
        h: placement.h,
      },
      spriteSourceSize: {
        x: 0,
        y: 0,
        w: placement.w,
        h: placement.h,
      },
      sourceSize: { w: placement.w, h: placement.h },
    });
  }

  const pngFile = path.join(outDir, pngName);
  fs.writeFileSync(
    pngFile,
    PNG.sync.write(atlas, { colorType: 6, inputColorType: 6 }),
  );
  pngFiles.push(pngName);
  textures.push({
    image: `assets/generated/actors/${pngName}`,
    format: 'RGBA8888',
    size: { w: page.width, h: page.height },
    scale: 1,
    frames,
  });
});

const multiatlas = {
  textures,
  meta: {
    app: 'rc-html5-avatar-baker',
    version: '1.0',
    baseline: raw.baseline,
    pageCount: pages.length,
    frames: physical.length,
    renderer: raw.renderer,
  },
};
fs.writeFileSync(
  path.join(outDir, 'restaurant-avatar-placeholder.json'),
  `${JSON.stringify(multiatlas, null, 2)}\n`,
);

const runtimeAnimations = {};
for (const animation of raw.animations ?? []) {
  const directions = {};
  for (const logical of animation.logicalDirections) {
    const physicalDirection =
      logical >= 5 ? 8 - logical : logical;
    const flipX = logical >= 5;
    const frameKeys = animation.historicalFrames.map(
      (historicalFrame) =>
        `avatar_service/${animation.name}/d${physicalDirection}/f${String(historicalFrame).padStart(3, '0')}`,
    );
    for (const frameKey of frameKeys) {
      if (!runtimeFrames[frameKey]) {
        throw new Error(
          `logical avatar direction references missing physical frame ${frameKey}`,
        );
      }
    }
    directions[String(logical)] = {
      physicalDirection,
      flipX,
      frameKeys,
    };
  }

  runtimeAnimations[animation.name] = {
    id: animation.id,
    frameDelayMs: animation.frameDelayMs,
    directions,
  };
}

const runtime = {
  schemaVersion: 1,
  baseline: raw.baseline,
  atlasKey: 'restaurant-avatar-placeholder',
  atlasJson: 'assets/generated/actors/restaurant-avatar-placeholder.json',
  physicalFrameCount: physical.length,
  sourceViewport: raw.sourceViewport,
  actorOriginViewport: raw.actorOriginViewport,
  tileHeightHalfPx: raw.tileHeightHalfPx,
  renderer: raw.renderer,
  camera: raw.camera,
  model: raw.model,
  animations: runtimeAnimations,
  frames: runtimeFrames,
};
fs.writeFileSync(
  path.join(outDir, 'restaurant-avatar-placeholder.runtime.json'),
  `${JSON.stringify(runtime, null, 2)}\n`,
);

console.log(
  `avatar-atlas: 98 physical frames -> ${pages.length} page(s) [${pages
    .map((page) => `${page.width}x${page.height}`)
    .join(', ')}]`,
);
console.log(
  `avatar-atlas: animations=${Object.keys(runtimeAnimations).length} png=${pngFiles.join(',')}`,
);
