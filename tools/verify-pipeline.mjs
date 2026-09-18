/**
 * Stage 4: verify-pipeline
 *
 * Re-extracts original SWFs and verifies every frame exactly once across
 * bounded multi-atlas pages.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runExtract } from './extract-symbols.mjs';
import { ATLAS_SWFS } from './lib/swf-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '..', 'public');
const ATLAS_DIR = path.join(PUBLIC, 'assets', 'generated', 'atlases');

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
      const atlas = JSON.parse(fs.readFileSync(atlasJsonFile, 'utf8'));

      if (!Array.isArray(atlas.textures) || atlas.textures.length === 0) {
        failures.push(`${swfName}: multi-atlas contains no texture pages`);
        continue;
      }

      const atlasKeys = new Set();
      let duplicateKeys = 0;

      for (const texture of atlas.textures) {
        const pngFile = path.resolve(PUBLIC, texture.image);
        if (!fs.existsSync(pngFile)) {
          failures.push(`${swfName}: missing atlas page ${texture.image}`);
          continue;
        }

        const pngSize = readPngSize(pngFile);
        if (texture.size.w !== pngSize.w || texture.size.h !== pngSize.h) {
          failures.push(
            `${swfName}: page ${texture.image} JSON size ${texture.size.w}x${texture.size.h} != PNG ${pngSize.w}x${pngSize.h}`,
          );
        }
        if (pngSize.w > 2048 || pngSize.h > 4096) {
          failures.push(
            `${swfName}: page ${texture.image} exceeds 2048x4096: ${pngSize.w}x${pngSize.h}`,
          );
        }

        for (const frame of texture.frames) {
          if (atlasKeys.has(frame.filename)) duplicateKeys += 1;
          atlasKeys.add(frame.filename);
        }
      }

      const expectedKeys = new Set(
        extract.symbols.flatMap((s) => s.frames.map((f) => f.key)),
      );
      const missing = [...expectedKeys].filter((k) => !atlasKeys.has(k));
      const extra = [...atlasKeys].filter((k) => !expectedKeys.has(k));

      if (missing.length > 0) {
        failures.push(`${swfName}: missing: ${missing.slice(0, 5).join(', ')}`);
      }
      if (extra.length > 0) {
        failures.push(`${swfName}: unexpected: ${extra.slice(0, 5).join(', ')}`);
      }
      if (duplicateKeys > 0) {
        failures.push(`${swfName}: repeats ${duplicateKeys} frame key(s)`);
      }
      if (extract.counts.symbols !== extract.symbols.length) {
        failures.push(
          `${swfName}: symbol coverage ${extract.symbols.length}/${extract.counts.symbols} < 100%`,
        );
      }

      console.log(
        `verify OK: ${swfName} — ${extract.symbols.length}/${extract.counts.symbols} symbols, ${expectedKeys.size} frames, ${atlas.textures.length} page(s)`,
      );
    } catch (err) {
      failures.push(`${swfName}: ${err.message}`);
    }
  }

  if (failures.length > 0) {
    console.error('verify FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return false;
  }

  console.log('verify: all SWFs pass');
  return true;
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
) {
  const names = process.argv.slice(2);
  verifyPipeline(names.length > 0 ? names : ATLAS_SWFS);
}
