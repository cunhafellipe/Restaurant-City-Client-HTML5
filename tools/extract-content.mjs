/**
 * Decode and inventory the historical Restaurant City data corpus.
 *
 * Historical *.bin responses were preserved in their zlib-encoded wire form.
 * The original ActionScript consumes XML after transport decompression.
 *
 * This tool intentionally writes decoded material only under tools/.work/
 * (gitignored/local build workspace). Git-safe output is metadata/hashes/counts.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WORK = path.join(HERE, '.work', 'content');
const DECODED = path.join(WORK, 'decoded');

export const CONTENT_FILES = [
  'appointment.bin',
  'avatar.bin',
  'challenge.bin',
  'front.bin',
  'ingredient.bin',
  'lang_en.bin',
  'lang_fr.bin',
  'model.bin',
  'perk.bin',
  'quiz.bin',
  'recipe.bin',
  'restaurant.bin',
  'newsletter.xml',
  'resconfig.xml',
];

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function decode(name, bytes) {
  if (name.endsWith('.bin') && bytes.length >= 2 && bytes[0] === 0x78) {
    return { encoding: 'zlib+xml', bytes: zlib.inflateSync(bytes) };
  }
  return { encoding: 'plain+xml', bytes };
}

function countMatches(text, re) {
  let n = 0;
  for (const _ of text.matchAll(re)) n += 1;
  return n;
}

function uniqueAttrCount(text, attr) {
  const values = new Set();
  const re = new RegExp(`\\b${attr}=(["'])(.*?)\\1`, 'g');
  for (const m of text.matchAll(re)) values.add(m[2]);
  return values.size;
}

function rootTag(text) {
  const withoutDecl = text.replace(/^\s*<\?xml[^>]*\?>/i, '');
  return withoutDecl.match(/<([A-Za-z_][\w:.-]*)\b/)?.[1] ?? null;
}

function structuralSchema(text) {
  const tags = new Map();
  const tagRe = /<([A-Za-z_][\w:.-]*)\b([^<>]*?)(?:\/?>)/g;
  const attrRe = /([A-Za-z_][\w:.-]*)\s*=\s*(["'])/g;

  for (const match of text.matchAll(tagRe)) {
    const tag = match[1];
    const attrs = match[2] ?? '';
    let entry = tags.get(tag);
    if (!entry) {
      entry = { count: 0, attributes: new Set() };
      tags.set(tag, entry);
    }
    entry.count += 1;
    for (const attr of attrs.matchAll(attrRe)) {
      entry.attributes.add(attr[1]);
    }
  }

  return Object.fromEntries(
    [...tags.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tag, entry]) => [
        tag,
        {
          count: entry.count,
          attributes: [...entry.attributes].sort(),
        },
      ]),
  );
}

export function extractContent(sourceRoot = REPO) {
  fs.mkdirSync(DECODED, { recursive: true });
  const files = [];
  let totalCompressedBytes = 0;
  let totalDecodedBytes = 0;

  for (const name of CONTENT_FILES) {
    const input = path.join(sourceRoot, name);
    if (!fs.existsSync(input)) {
      files.push({ name, present: false });
      continue;
    }

    const raw = fs.readFileSync(input);
    const decoded = decode(name, raw);
    const text = decoded.bytes.toString('utf8');

    if (!/^\s*(?:<\?xml[^>]*\?>\s*)?</.test(text)) {
      throw new Error(`${name}: decoded payload is not XML`);
    }

    const outName = name.replace(/\.bin$/i, '.xml');
    fs.writeFileSync(path.join(DECODED, outName), decoded.bytes);

    const record = {
      name,
      present: true,
      wireEncoding: decoded.encoding,
      compressedBytes: raw.length,
      decodedBytes: decoded.bytes.length,
      compressedSha256: sha256(raw),
      decodedSha256: sha256(decoded.bytes),
      root: rootTag(text),
      schema: structuralSchema(text),
      structure: {
        groups: countMatches(text, /<group\b/g),
        items: countMatches(text, /<item\b/g),
        challenges: countMatches(text, /<challenge\b/g),
        rewards: countMatches(text, /<reward\b/g),
        resources: countMatches(text, /<resource\b/g),
        paths: countMatches(text, /<path\b/g),
        uniqueIds: uniqueAttrCount(text, 'id'),
        uniqueNames: uniqueAttrCount(text, 'name'),
      },
    };
    files.push(record);
    totalCompressedBytes += raw.length;
    totalDecodedBytes += decoded.bytes.length;
  }

  const present = files.filter((f) => f.present);
  const index = {
    schemaVersion: 1,
    source: 'Restaurant City canonical/historical corpus',
    generatedAt: new Date().toISOString(),
    policy: {
      decodedOutput: 'local-workspace-only',
      gitSafeOutput: 'metadata-only',
      rightsClass: 'LEGACY_RESEARCH',
    },
    counts: {
      expectedFiles: CONTENT_FILES.length,
      presentFiles: present.length,
      missingFiles: CONTENT_FILES.length - present.length,
      compressedBytes: totalCompressedBytes,
      decodedBytes: totalDecodedBytes,
      groups: present.reduce((n, f) => n + f.structure.groups, 0),
      items: present.reduce((n, f) => n + f.structure.items, 0),
      challenges: present.reduce((n, f) => n + f.structure.challenges, 0),
      resources: present.reduce((n, f) => n + f.structure.resources, 0),
    },
    files,
  };

  fs.writeFileSync(path.join(WORK, 'content-index.json'), `${JSON.stringify(index, null, 2)}\n`);
  console.log(
    `content: ${index.counts.presentFiles}/${index.counts.expectedFiles} files, ` +
      `${index.counts.items} items, ${index.counts.groups} groups, ` +
      `${index.counts.challenges} challenges`,
  );
  return index;
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\\\/g, '/')}`).href
) {
  extractContent(process.argv[2] ? path.resolve(process.argv[2]) : REPO);
}
