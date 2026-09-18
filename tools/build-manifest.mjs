/**
 * Stage 3: build-manifest
 *
 * Emits runtime manifest and per-SWF coverage. Atlas entries reference a
 * Phaser multi-atlas JSON plus its bounded PNG page set.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATLAS_SWFS, SWFS } from './lib/swf-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.join(HERE, '.work');
const GEN_DIR = path.resolve(HERE, '..', 'public', 'assets', 'generated');
const ATLAS_DIR = path.join(GEN_DIR, 'atlases');

export function buildManifest(swfNames) {
  const atlases = [];
  const coverage = {};

  for (const swfName of swfNames) {
    const cfg = SWFS[swfName];
    if (!cfg) throw new Error(`unknown SWF "${swfName}"`);

    const extract = JSON.parse(
      fs.readFileSync(path.join(WORK, swfName, 'extract.json'), 'utf8'),
    );
    const atlas = JSON.parse(
      fs.readFileSync(path.join(ATLAS_DIR, `${swfName}.json`), 'utf8'),
    );

    const atlasKeys = new Set(
      atlas.textures.flatMap((t) => t.frames.map((f) => f.filename)),
    );
    const expectedKeys = new Set(
      extract.symbols.flatMap((s) => s.frames.map((f) => f.key)),
    );
    const missing = [...expectedKeys].filter((k) => !atlasKeys.has(k));
    const extra = [...atlasKeys].filter((k) => !expectedKeys.has(k));

    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `atlas/extract mismatch for ${swfName}: missing=${missing.length} extra=${extra.length}`,
      );
    }

    const symbols = extract.counts.symbols;
    const exported = extract.symbols.length;
    const pct = symbols === 0 ? 100 : Math.round((exported / symbols) * 1000) / 10;

    coverage[swfName] = {
      symbols,
      exported,
      frames: extract.counts.frames,
      pct,
      pages: atlas.textures.length,
      excluded: extract.excluded,
    };

    atlases.push({
      id: swfName,
      json: `atlases/${swfName}.json`,
      files: atlas.textures.map((t) =>
        t.image.replace(/^assets\/generated\//, ''),
      ),
      source: cfg.source,
    });
  }

  const manifest = {
    version: 2,
    atlases,
    audio: [],
    data: [],
    langs: [],
    coverage,
  };
  const manifestFile = path.join(GEN_DIR, 'manifest.json');
  fs.mkdirSync(GEN_DIR, { recursive: true });
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log('manifest:', manifestFile);
  for (const [name, c] of Object.entries(coverage)) {
    console.log(
      `  coverage ${name}: ${c.exported}/${c.symbols} symbols (${c.pct}%), ${c.frames} frames, ${c.pages} page(s)`,
    );
  }
  return manifest;
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
) {
  const names = process.argv.slice(2);
  buildManifest(names.length > 0 ? names : ATLAS_SWFS);
}
