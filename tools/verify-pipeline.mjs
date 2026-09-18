/**
 * Stage 4: verify-pipeline
 *
 * Re-runs extraction from the original SWF (never trusting stale work
 * output) and checks the pipeline contract:
 *
 *   - every linked symbol has exported frames (100% symbol coverage)
 *   - atlas JSON contains exactly the extracted frame keys
 *   - the generated atlas PNG exists and its header matches the JSON size
 *
 * Exits non-zero on any failure — coverage failure is a build error, not a
 * warning (docs/04-asset-pipeline.md).
 *
 *   node tools/verify-pipeline.mjs [swfName ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runExtract } from './extract-symbols.mjs';
import { ATLAS_SWFS } from './lib/swf-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GEN_DIR = path.resolve(HERE, '..', 'public', 'assets', 'generated');
const ATLAS_DIR = path.join(GEN_DIR, 'atlases');

function readPngSize(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error(`not a PNG: ${file}`);
  }
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

export function verifyPipeline(swfNames) {
  const failures = [];
  for (const swfName of swfNames) {
    try {
      const { extract } = runExtract(swfName);
      const atlasJsonFile = path.join(ATLAS_DIR, `${swfName}.json`);
      const atlasPngFile = path.join(ATLAS_DIR, `${swfName}.png`);
      const atlas = JSON.parse(fs.readFileSync(atlasJsonFile, 'utf8'));
      const atlasKeys = new Set(
        atlas.textures.flatMap((t) => t.frames.map((f) => f.filename)),
      );
      const expectedKeys = new Set(
        extract.symbols.flatMap((s) => s.frames.map((f) => f.key)),
      );

      const missing = [...expectedKeys].filter((k) => !atlasKeys.has(k));
      const extra = [...atlasKeys].filter((k) => !expectedKeys.has(k));
      if (missing.length > 0) {
        failures.push(`${swfName}: atlas missing frames: ${missing.slice(0, 5).join(', ')}`);
      }
      if (extra.length > 0) {
        failures.push(`${swfName}: atlas has unexpected frames: ${extra.slice(0, 5).join(', ')}`);
      }

      if (extract.counts.symbols !== extract.symbols.length) {
        failures.push(
          `${swfName}: symbol coverage ${extract.symbols.length}/${extract.counts.symbols} < 100%`,
        );
      }

      const pngSize = readPngSize(atlasPngFile);
      for (const t of atlas.textures) {
        if (t.size.w !== pngSize.w || t.size.h !== pngSize.h) {
          failures.push(
            `${swfName}: atlas JSON size ${t.size.w}x${t.size.h} != PNG ${pngSize.w}x${pngSize.h}`,
          );
        }
      }
      console.log(
        `verify OK: ${swfName} — ${extract.symbols.length}/${extract.counts.symbols} symbols, ` +
          `${expectedKeys.size} frames, atlas ${pngSize.w}x${pngSize.h}`,
      );
    } catch (err) {
      failures.push(`${swfName}: ${err.message}`);
    }
  }

  if (failures.length > 0) {
    console.error('verify FAILED:');
    for (const f of failures) {
      console.error(`  - ${f}`);
    }
    process.exitCode = 1;
    return false;
  }
  console.log('verify: all SWFs pass');
  return true;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  const names = process.argv.slice(2);
  verifyPipeline(names.length > 0 ? names : ATLAS_SWFS);
}
