/**
 * Stage 1: extract-symbols
 *
 * Extracts every linked sprite from a source SWF into per-frame PNGs and
 * writes work/<swf>/extract.json describing symbols, frames, and keys.
 *
 *   node tools/extract-symbols.mjs [swfName]   (default: ingredient_asset)
 *
 * Outputs (all under tools/.work/<swf>/):
 *   symbolclass/symbols.csv   FFDec linkage tables (ExportAssets + SymbolClass)
 *   sprites/                  per-sprite frame PNGs from FFDec sprite export
 *   extract.json              normalized symbol/frame manifest (input to atlas)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ffdec } from './lib/ffdec.mjs';
import { parseDump } from './lib/dump-parse.mjs';
import { frameKey } from './lib/keys.mjs';
import { SWFS } from './lib/swf-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(HERE, '..');
const WORK = path.join(HERE, '.work');

function readPngSize(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error(`not a PNG: ${file}`);
  }
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** Parse FFDec symbolClass CSV (chid;"Name" rows; may contain duplicates). */
function parseSymbolCsv(text) {
  const byChid = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\d+);"([^"]*)"$/);
    if (m) {
      const chid = Number(m[1]);
      const name = m[2];
      if (!byChid.has(chid) || byChid.get(chid) === '') {
        byChid.set(chid, name);
      }
    }
  }
  return byChid;
}

export function runExtract(swfName) {
  const cfg = SWFS[swfName];
  if (!cfg) {
    throw new Error(`unknown SWF "${swfName}" — see tools/lib/swf-config.mjs`);
  }
  const swfPath = path.join(WORKSPACE_ROOT, cfg.source);
  const work = path.join(WORK, swfName);
  const spriteDir = path.join(work, 'sprites');
  const csvDir = path.join(work, 'symbolclass');
  fs.mkdirSync(work, { recursive: true });

  // 1. Tag tree -> sprite frame labels.
  const dump = ffdec(['-dumpSWF', swfPath]);
  const spriteFrames = parseDump(dump.stdout);

  // 2. Linkage tables (ExportAssets + SymbolClass) -> name per chid.
  const csvOut = ffdec(['-export', 'symbolClass', csvDir, swfPath]);
  const csvFile = path.join(csvDir, 'symbols.csv');
  if (!fs.existsSync(csvFile)) {
    throw new Error(`symbolClass export produced no symbols.csv: ${csvOut.stderr}`);
  }
  const symbolsByName = parseSymbolCsv(fs.readFileSync(csvFile, 'utf8'));

  // 3. Sprite frame PNGs.
  const spriteOut = ffdec(['-format', 'sprite:png', '-export', 'sprite', spriteDir, swfPath]);
  if (!/OK/.test(spriteOut.stdout + spriteOut.stderr)) {
    throw new Error(`sprite export failed: ${spriteOut.stderr || spriteOut.stdout}`);
  }

  // 4. Normalize into extract.json.
  const spriteDirs = new Map(
    fs
      .readdirSync(spriteDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const m = d.name.match(/^DefineSprite_(\d+)(?:_|$)/);
        return m ? [Number(m[1]), d.name] : null;
      })
      .filter(Boolean),
  );

  const symbols = [];
  const excluded = [];
  for (const [chid, name] of [...symbolsByName.entries()].sort((a, b) => a[0] - b[0])) {
    if (chid === 0) {
      excluded.push({ chid, name, reason: 'main timeline root (empty single frame, linkage marker)' });
      continue;
    }
    if (!name) {
      excluded.push({ chid, name: '', reason: 'linked with no export name' });
      continue;
    }
    const dirName = spriteDirs.get(chid);
    if (!dirName) {
      throw new Error(`no sprite export folder for chid ${chid} ("${name}")`);
    }
    const dir = path.join(spriteDir, dirName);
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^\d+\.png$/.test(f))
      .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
    const labels = spriteFrames.get(chid)?.frames ?? [];
    const frames = files.map((file, i) => {
      const label = labels[i]?.label ?? null;
      const { w, h } = readPngSize(path.join(dir, file));
      return {
        file: path.relative(work, path.join(dir, file)),
        key: frameKey(swfName, name, label, i + 1),
        label,
        index: i + 1,
        w,
        h,
      };
    });
    if (frames.length === 0) {
      throw new Error(`sprite "${name}" (chid ${chid}) exported no frames`);
    }
    symbols.push({ chid, name, frames });
  }

  const extract = {
    swf: swfName,
    source: cfg.source,
    stage: cfg.stage,
    generatedAt: new Date().toISOString(),
    counts: {
      symbols: symbols.length,
      frames: symbols.reduce((n, s) => n + s.frames.length, 0),
    },
    excluded,
    symbols,
  };
  const extractFile = path.join(work, 'extract.json');
  fs.writeFileSync(extractFile, `${JSON.stringify(extract, null, 2)}\n`);
  console.log(
    `extract: ${swfName} -> ${extract.counts.symbols} symbols, ${extract.counts.frames} frames (${extractFile})`,
  );
  return { extract, work };
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  const swfName = process.argv[2] ?? 'ingredient_asset';
  runExtract(swfName);
}
