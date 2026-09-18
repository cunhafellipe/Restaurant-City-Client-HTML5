/**
 * Full local ANEWON Restaurant City content build.
 *
 * Requires the historical source files to exist in the repository working
 * directory (normally copied from the private Vault by the trusted runner).
 * Outputs are gitignored development derivatives only.
 */
import { ATLAS_SWFS } from './lib/swf-config.mjs';
import { runExtract } from './extract-symbols.mjs';
import { buildAtlas } from './build-atlases.mjs';
import { buildData } from './build-data.mjs';
import { extractAudio } from './build-audio.mjs';
import { buildManifest } from './build-manifest.mjs';
import { verifyPipeline } from './verify-pipeline.mjs';

buildData();

for (const swfName of ATLAS_SWFS) {
  runExtract(swfName);
  buildAtlas(swfName);
}

extractAudio();
buildManifest(ATLAS_SWFS);

const ok = verifyPipeline(ATLAS_SWFS);
process.exitCode = ok ? 0 : 1;
