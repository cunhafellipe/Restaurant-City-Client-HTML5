/**
 * Extract the original sound_asset.swf embedded audio for local ANEWON
 * development/research.
 *
 * Output is gitignored. This stage does not decide release rights and does not
 * upload historical audio to CI artifacts.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ffdec } from './lib/ffdec.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WORK = path.join(HERE, '.work', 'sound_asset');
const EXPORT = path.join(WORK, 'ffdec');
const OUT = path.join(REPO, 'public', 'assets', 'generated', 'audio');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

export function extractAudio() {
  const swf = path.join(REPO, 'sound_asset.swf');
  if (!fs.existsSync(swf)) {
    throw new Error(`sound_asset.swf not found at ${swf}`);
  }

  fs.rmSync(WORK, { recursive: true, force: true });
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(EXPORT, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  const result = ffdec(['-export', 'sound', EXPORT, swf]);
  const exported = walkFiles(EXPORT);

  if (exported.length === 0) {
    throw new Error(`FFDec exported no audio: ${result.stderr || result.stdout}`);
  }

  const files = [];
  for (const [index, source] of exported.entries()) {
    const ext = path.extname(source).toLowerCase() || '.bin';
    const name = `sound-${String(index).padStart(3, '0')}${ext}`;
    const dest = path.join(OUT, name);
    fs.copyFileSync(source, dest);
    files.push({
      id: `sound-${String(index).padStart(3, '0')}`,
      file: `audio/${name}`,
      sourceExportName: path.basename(source),
      format: ext.slice(1),
      bytes: fs.statSync(dest).size,
      sha256: sha256(dest),
    });
  }

  const manifest = {
    version: 1,
    source: 'sound_asset.swf',
    rightsClass: 'LEGACY_RESEARCH',
    generatedAt: new Date().toISOString(),
    files,
  };
  fs.writeFileSync(
    path.join(WORK, 'audio-index.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  console.log(
    `audio: sound_asset.swf -> ${files.length} exported track(s)/sound(s), ` +
      `${files.reduce((n, file) => n + file.bytes, 0)} bytes`,
  );
  return manifest;
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
) {
  extractAudio();
}
