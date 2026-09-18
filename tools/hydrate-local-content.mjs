/**
 * Hydrate local development runtime derivatives produced by the trusted R16
 * pipeline. Historical source SWF/BIN files are never copied by this command.
 *
 * Default ANEWON path:
 * C:\ANEWON\Workspace\restaurant-city\implementation\assets-r16\generated
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DEFAULT_ROOT =
  process.platform === 'win32'
    ? 'C:\\ANEWON\\Workspace\\restaurant-city\\implementation\\assets-r16\\generated'
    : '';

const source = path.resolve(
  process.argv[2] || process.env.ANEWON_RC_DERIVED_ROOT || DEFAULT_ROOT,
);
const destination = path.join(REPO, 'public', 'assets', 'generated');

if (!source || !fs.existsSync(source)) {
  throw new Error(
    'Generated ANEWON Restaurant City content not found. Run the trusted R16 pipeline or pass its generated directory.',
  );
}

const manifest = path.join(source, 'manifest.json');
if (!fs.existsSync(manifest)) {
  throw new Error(`Refusing hydration: manifest.json missing from ${source}`);
}

const forbidden = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:swf|bin|rar|zip|7z)$/i.test(entry.name)) forbidden.push(full);
  }
}
walk(source);
if (forbidden.length > 0) {
  throw new Error(
    `Refusing hydration: source contains historical/archive bytes: ${forbidden
      .slice(0, 5)
      .join(', ')}`,
  );
}

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.cpSync(source, destination, { recursive: true });

const parsed = JSON.parse(fs.readFileSync(path.join(destination, 'manifest.json'), 'utf8'));
console.log(
  `hydrate: local derivatives -> ${destination} | manifest v${parsed.version} | ` +
    `atlases=${parsed.atlases?.length ?? 0} data=${parsed.data?.length ?? 0} audio=${parsed.audio?.length ?? 0}`,
);
