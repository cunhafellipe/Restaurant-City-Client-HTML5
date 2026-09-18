import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');
const DIST = path.join(REPO, 'dist');
const MANIFEST = path.join(PUBLIC, 'assets', 'generated', 'manifest.json');

const forbiddenFileExtensions = new Set([
  '.swf',
  '.bin',
  '.rar',
  '.zip',
  '.7z',
  '.exe',
]);

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

function relative(file) {
  return path.relative(REPO, file).replaceAll('\\', '/');
}

const violations = [];

for (const root of [PUBLIC, DIST]) {
  for (const file of walk(root)) {
    if (forbiddenFileExtensions.has(path.extname(file).toLowerCase())) {
      violations.push(`forbidden runtime file: ${relative(file)}`);
    }
  }
}

for (const file of walk(path.join(REPO, 'src'))) {
  if (!/\.(?:ts|tsx|js|html)$/i.test(file)) continue;
  const source = fs.readFileSync(file, 'utf8');

  const runtimePatterns = [
    [/ruffle/i, 'Ruffle/Flash emulation reference'],
    [/application\/x-shockwave-flash/i, 'Flash MIME reference'],
    [/<(?:object|embed)\b[^>]*flash/i, 'Flash object/embed reference'],
    [
      /(?:fetch|load|src\s*=)[\s\S]{0,120}["'`][^"'`]*\.(?:swf|bin)(?:[?"'`]|$)/i,
      'runtime SWF/BIN load reference',
    ],
  ];

  for (const [pattern, label] of runtimePatterns) {
    if (pattern.test(source)) {
      violations.push(`${label}: ${relative(file)}`);
    }
  }
}

if (!fs.existsSync(MANIFEST)) {
  violations.push('generated runtime manifest missing');
} else {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

  if (manifest.version !== 3) {
    violations.push(`runtime manifest version is ${manifest.version}, expected 3`);
  }

  for (const entry of manifest.data ?? []) {
    if (!String(entry.xml ?? '').endsWith('.xml')) {
      violations.push(`data ${entry.id} does not use normalized XML`);
    }
    if (
      entry.itemDatabase !== null &&
      entry.itemDatabase !== undefined &&
      !String(entry.itemDatabase).endsWith('.json')
    ) {
      violations.push(`data ${entry.id} ItemDatabase is not JSON`);
    }
  }

  for (const atlas of manifest.atlases ?? []) {
    if (!String(atlas.json ?? '').endsWith('.json')) {
      violations.push(`atlas ${atlas.id} descriptor is not JSON`);
    }
    for (const file of atlas.files ?? []) {
      if (!String(file).endsWith('.png')) {
        violations.push(`atlas ${atlas.id} page is not PNG: ${file}`);
      }
    }
  }

  const webAudio = /\.(?:mp3|ogg|wav|m4a|aac)$/i;
  for (const audio of manifest.audio ?? []) {
    if (!webAudio.test(String(audio.file ?? ''))) {
      violations.push(`audio ${audio.id} is not a browser-native audio file`);
    }
  }
}

const pkg = JSON.parse(
  fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'),
);
for (const [section, deps] of Object.entries({
  dependencies: pkg.dependencies ?? {},
  devDependencies: pkg.devDependencies ?? {},
})) {
  for (const name of Object.keys(deps)) {
    if (/ruffle|flash|swf/i.test(name)) {
      violations.push(`forbidden runtime dependency in ${section}: ${name}`);
    }
  }
}

if (violations.length > 0) {
  console.error('WEB-NATIVE RUNTIME FAIL');
  for (const violation of violations) console.error(` - ${violation}`);
  process.exitCode = 1;
} else {
  console.log(
    'WEB-NATIVE RUNTIME PASS | HTML/CSS/TypeScript/Phaser + generated web derivatives only',
  );
}
