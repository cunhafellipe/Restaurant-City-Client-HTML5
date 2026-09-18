/**
 * pipeline — run all stages for the given SWFs in order:
 *
 *   extract-symbols -> build-atlases -> build-manifest -> verify-pipeline
 *
 *   node tools/pipeline.mjs [swfName ...]   (default: all visual asset SWFs)
 */
import { runExtract } from './extract-symbols.mjs';
import { buildAtlas } from './build-atlases.mjs';
import { buildManifest } from './build-manifest.mjs';
import { verifyPipeline } from './verify-pipeline.mjs';
import { ATLAS_SWFS } from './lib/swf-config.mjs';

const names = process.argv.slice(2);
const targets = names.length > 0 ? names : ATLAS_SWFS;
const unknown = targets.filter((n) => !ATLAS_SWFS.includes(n));
if (unknown.length > 0) {
  console.error(`not an atlas SWF: ${unknown.join(', ')} (known: ${ATLAS_SWFS.join(', ')})`);
  process.exit(1);
}

console.log(`pipeline targets: ${targets.join(', ')}`);
for (const swfName of targets) {
  runExtract(swfName);
  buildAtlas(swfName);
}
buildManifest(targets);
const ok = verifyPipeline(targets);
process.exitCode = ok ? 0 : 1;
