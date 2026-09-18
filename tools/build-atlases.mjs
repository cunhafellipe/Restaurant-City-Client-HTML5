/**
 * Stage 2: build-atlases
 *
 * Packs extracted frames into bounded atlas pages and writes Phaser
 * multi-atlas JSON. Small SWFs retain the historical single-PNG name.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { packFramePages } from './lib/packer.mjs';
import { SWFS } from './lib/swf-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.join(HERE, '.work');
const PUBLIC = path.resolve(HERE, '..', 'public');
const OUT_DIR = path.join(PUBLIC, 'assets', 'generated', 'atlases');

export function buildAtlas(swfName) {
  const cfg = SWFS[swfName];
  if (!cfg) {
    throw new Error(`unknown SWF "${swfName}" — see tools/lib/swf-config.mjs`);
  }

  const work = path.join(WORK, swfName);
  const extract = JSON.parse(fs.readFileSync(path.join(work, 'extract.json'), 'utf8'));
  const frames = [];

  for (const symbol of extract.symbols) {
    for (const f of symbol.frames) {
      frames.push({ ...f, abs: path.join(work, f.file) });
    }
  }
  frames.sort((a, b) => a.key.localeCompare(b.key));

  const frameByKey = new Map(frames.map((f) => [f.key, f]));
  const pages = packFramePages(frames, {
    maxWidth: 2048,
    maxHeight: 4096,
    padding: 2,
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const file of fs.readdirSync(OUT_DIR)) {
    if (
      file === `${swfName}.png` ||
      (file.startsWith(`${swfName}-`) && file.endsWith('.png'))
    ) {
      fs.rmSync(path.join(OUT_DIR, file));
    }
  }

  const textures = [];
  const pngFiles = [];

  pages.forEach((page, pageIndex) => {
    const pngName =
      pages.length === 1 ? `${swfName}.png` : `${swfName}-${pageIndex}.png`;
    const pngFile = path.join(OUT_DIR, pngName);
    const image = `assets/generated/atlases/${pngName}`;
    const pagePng = new PNG({ width: page.width, height: page.height });
    const pageFrames = [];

    for (const placement of page.placements) {
      const f = frameByKey.get(placement.key);
      if (!f) {
        throw new Error(`missing extracted frame for placement ${placement.key}`);
      }
      const src = PNG.sync.read(fs.readFileSync(f.abs));
      PNG.bitblt(src, pagePng, 0, 0, f.w, f.h, placement.x, placement.y);
      pageFrames.push({
        filename: f.key,
        rotated: false,
        trimmed: false,
        frame: {
          x: placement.x,
          y: placement.y,
          w: placement.w,
          h: placement.h,
        },
        spriteSourceSize: { x: 0, y: 0, w: placement.w, h: placement.h },
        sourceSize: { w: placement.w, h: placement.h },
      });
    }

    fs.writeFileSync(
      pngFile,
      PNG.sync.write(pagePng, { colorType: 6, inputColorType: 6 }),
    );
    pngFiles.push(pngFile);
    textures.push({
      image,
      format: 'RGBA8888',
      size: { w: page.width, h: page.height },
      scale: 1,
      frames: pageFrames,
    });
  });

  const json = {
    textures,
    meta: {
      app: 'rc-html5-pipeline',
      version: '2.0',
      swf: swfName,
      pageCount: pages.length,
      frames: frames.length,
    },
  };
  const jsonFile = path.join(OUT_DIR, `${swfName}.json`);
  fs.writeFileSync(jsonFile, `${JSON.stringify(json, null, 2)}\n`);

  console.log(
    `atlas: ${swfName} -> ${pages.length} page(s), ${frames.length} frames [${pages
      .map((p) => `${p.width}x${p.height}`)
      .join(', ')}]`,
  );

  return {
    pngFiles,
    jsonFile,
    atlas: json,
    frameCount: frames.length,
    pages: pages.map(({ width, height }) => ({ width, height })),
  };
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
) {
  buildAtlas(process.argv[2] ?? 'ingredient_asset');
}
