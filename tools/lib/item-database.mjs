/**
 * Parser for the historical Restaurant City ItemDatabase XML shape.
 *
 * Mirrors ItemDatabase.as semantics:
 * - root contains <group> elements;
 * - group name/type plus arbitrary attributes;
 * - group type becomes an array split on commas;
 * - each <item> starts with cash=0/cost=0;
 * - item type becomes an array;
 * - "true"/"false" become booleans;
 * - "null" becomes null;
 * - all other attribute values remain strings;
 * - child XML is retained as an opaque string for later family-specific readers.
 *
 * This is deliberately a narrow parser for recovered RC data, not a general XML parser.
 */

function decodeXmlEntity(value) {
  return value.replace(
    /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g,
    (_, entity) => {
      if (entity === 'amp') return '&';
      if (entity === 'lt') return '<';
      if (entity === 'gt') return '>';
      if (entity === 'quot') return '"';
      if (entity === 'apos') return "'";
      if (entity.startsWith('#x')) {
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith('#')) {
        return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      }
      return _;
    },
  );
}

export function parseXmlAttributes(source) {
  const attrs = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/g;
  for (const match of source.matchAll(re)) {
    attrs[match[1]] = decodeXmlEntity(match[3]);
  }
  return attrs;
}

export function legacyAttributeValue(name, value) {
  if (name === 'type') {
    return value
      .split(/\s*,\s*/)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  return value;
}

function normalizeAttributes(attrs, defaults = {}) {
  const normalized = { ...defaults };
  for (const [name, value] of Object.entries(attrs)) {
    normalized[name] = legacyAttributeValue(name, value);
  }
  return normalized;
}

export function parseItemDatabaseXml(xml) {
  const groups = [];
  const groupRe = /<group\b([^>]*)>([\s\S]*?)<\/group\s*>/gi;

  for (const groupMatch of xml.matchAll(groupRe)) {
    const rawGroupAttrs = parseXmlAttributes(groupMatch[1]);
    const groupName = rawGroupAttrs.name ?? '';
    const groupAttrs = normalizeAttributes(rawGroupAttrs);
    const body = groupMatch[2];
    const items = [];

    const itemRe =
      /<item\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/item\s*>)/gi;
    for (const itemMatch of body.matchAll(itemRe)) {
      const rawItemAttrs = parseXmlAttributes(itemMatch[1]);
      const attrs = normalizeAttributes(rawItemAttrs, { cash: 0, cost: 0 });
      items.push({
        group: groupName,
        attributes: attrs,
        childrenXml: (itemMatch[2] ?? '').trim(),
      });
    }

    groups.push({
      name: groupName,
      attributes: groupAttrs,
      items,
    });
  }

  return {
    schemaVersion: 1,
    groups,
    counts: {
      groups: groups.length,
      items: groups.reduce((total, group) => total + group.items.length, 0),
    },
  };
}
