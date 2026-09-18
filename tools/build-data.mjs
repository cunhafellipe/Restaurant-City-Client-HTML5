/**
 * Build development/runtime data derivatives from the recovered historical
 * Restaurant City corpus.
 *
 * Historical bytes remain outside Git. Outputs go under the gitignored
 * public/assets/generated/data directory and remain LEGACY_RESEARCH until a
 * release classification says otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractContent } from './extract-content.mjs';
import { parseItemDatabaseXml } from './lib/item-database.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WORK = path.join(HERE, '.work', 'content');
const DECODED = path.join(WORK, 'decoded');
const OUT = path.join(REPO, 'public', 'assets', 'generated', 'data');

function familyFromName(name) {
  return name.replace(/\.(?:bin|xml)$/i, '');
}

export function buildData(sourceRoot = REPO) {
  const content = extractContent(sourceRoot);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const families = [];

  for (const file of content.files) {
    if (!file.present) continue;

    const family = familyFromName(file.name);
    const decodedName = file.name.replace(/\.bin$/i, '.xml');
    const decodedFile = path.join(DECODED, decodedName);
    const xmlName = `${family}.xml`;
    const xmlOut = path.join(OUT, xmlName);
    fs.copyFileSync(decodedFile, xmlOut);

    const entry = {
      family,
      source: file.name,
      xml: `data/${xmlName}`,
      wireEncoding: file.wireEncoding,
      sourceSha256: file.compressedSha256,
      decodedSha256: file.decodedSha256,
      counts: file.structure,
    };

    if (file.structure.groups > 0) {
      const xml = fs.readFileSync(decodedFile, 'utf8');
      const itemDb = parseItemDatabaseXml(xml);
      if (
        itemDb.counts.groups !== file.structure.groups ||
        itemDb.counts.items !== file.structure.items
      ) {
        throw new Error(
          `${file.name}: ItemDatabase parser coverage mismatch: ` +
            `groups ${itemDb.counts.groups}/${file.structure.groups}, ` +
            `items ${itemDb.counts.items}/${file.structure.items}`,
        );
      }

      const itemName = `${family}.items.json`;
      fs.writeFileSync(
        path.join(OUT, itemName),
        `${JSON.stringify(itemDb, null, 2)}\n`,
      );
      entry.itemDatabase = `data/${itemName}`;
    }

    families.push(entry);
  }

  families.sort((a, b) => a.family.localeCompare(b.family));

  const runtimeIndex = {
    schemaVersion: 1,
    rightsClass: 'LEGACY_RESEARCH',
    releaseEligible: false,
    baseline: '0.9.143a',
    families,
  };

  fs.writeFileSync(
    path.join(OUT, 'runtime-index.json'),
    `${JSON.stringify(runtimeIndex, null, 2)}\n`,
  );

  console.log(
    `data: ${families.length} families -> runtime-index.json; ` +
      `${families.filter((family) => family.itemDatabase).length} ItemDatabase family/families`,
  );

  return runtimeIndex;
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
) {
  buildData(process.argv[2] ? path.resolve(process.argv[2]) : REPO);
}
