/**
 * Parser for the historical Restaurant City ItemDatabase XML shape.
 *
 * Mirrors ItemDatabase.as / E4X semantics:
 * - root direct children named <group> are database groups;
 * - group direct children named <item> are database items;
 * - nested <item> elements inside an item's child XML are NOT database items;
 * - comments, CDATA and processing instructions are not elements;
 * - group name/type plus arbitrary attributes are preserved;
 * - group/item type becomes an array split on commas;
 * - each item starts with cash=0/cost=0;
 * - "true"/"false" become booleans;
 * - "null" becomes null;
 * - all other attribute values remain strings;
 * - item child XML is retained verbatim (trimmed) for family-specific readers.
 *
 * This is deliberately a narrow structural scanner for recovered RC data,
 * not a general-purpose XML library.
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

function findTagEnd(xml, start) {
  let quote = null;
  for (let i = start; i < xml.length; i += 1) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  throw new Error(`unterminated XML tag at offset ${start}`);
}

function skipSpecial(xml, start) {
  if (xml.startsWith('<!--', start)) {
    const end = xml.indexOf('-->', start + 4);
    if (end < 0) throw new Error('unterminated XML comment');
    return end + 3;
  }
  if (xml.startsWith('<![CDATA[', start)) {
    const end = xml.indexOf(']]>', start + 9);
    if (end < 0) throw new Error('unterminated CDATA section');
    return end + 3;
  }
  if (xml.startsWith('<?', start)) {
    const end = xml.indexOf('?>', start + 2);
    if (end < 0) throw new Error('unterminated processing instruction');
    return end + 2;
  }
  if (xml.startsWith('<!', start)) {
    // Historical RC data has no complex DTD; still honor quotes while finding
    // the declaration close so '>' inside a quoted literal is harmless.
    return findTagEnd(xml, start + 2) + 1;
  }
  return null;
}

function scanXmlElements(xml) {
  const roots = [];
  const stack = [];
  let cursor = 0;

  while (cursor < xml.length) {
    const start = xml.indexOf('<', cursor);
    if (start < 0) break;

    const specialEnd = skipSpecial(xml, start);
    if (specialEnd !== null) {
      cursor = specialEnd;
      continue;
    }

    const tagEnd = findTagEnd(xml, start + 1);
    const inner = xml.slice(start + 1, tagEnd).trim();

    if (inner.startsWith('/')) {
      const closeName = inner.slice(1).trim().split(/\s+/, 1)[0];
      const node = stack.pop();
      if (!node || node.name !== closeName) {
        throw new Error(
          `malformed XML close tag </${closeName}> at offset ${start}`,
        );
      }
      node.endTagStart = start;
      node.endTagEnd = tagEnd + 1;
      cursor = tagEnd + 1;
      continue;
    }

    const selfClosing = /\/\s*$/.test(inner);
    const body = selfClosing ? inner.replace(/\/\s*$/, '').trim() : inner;
    const nameMatch = body.match(/^([A-Za-z_][\w:.-]*)\b/);
    if (!nameMatch) {
      throw new Error(`invalid XML element at offset ${start}`);
    }

    const name = nameMatch[1];
    const attrsText = body.slice(name.length).trim();
    const node = {
      name,
      attrsText,
      startTagStart: start,
      startTagEnd: tagEnd + 1,
      endTagStart: selfClosing ? tagEnd + 1 : null,
      endTagEnd: selfClosing ? tagEnd + 1 : null,
      children: [],
    };

    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);

    if (!selfClosing) stack.push(node);
    cursor = tagEnd + 1;
  }

  if (stack.length > 0) {
    throw new Error(`unterminated XML element <${stack.at(-1).name}>`);
  }
  return roots;
}

export function parseItemDatabaseXml(xml) {
  const roots = scanXmlElements(xml);
  const root = roots.find((node) => node.name !== '');
  if (!root) {
    throw new Error('ItemDatabase XML has no document element');
  }

  const groups = [];
  for (const groupNode of root.children.filter(
    (node) => node.name.toLowerCase() === 'group',
  )) {
    const rawGroupAttrs = parseXmlAttributes(groupNode.attrsText);
    const groupName = rawGroupAttrs.name ?? '';
    const groupAttrs = normalizeAttributes(rawGroupAttrs);
    const items = [];

    for (const itemNode of groupNode.children.filter(
      (node) => node.name.toLowerCase() === 'item',
    )) {
      const rawItemAttrs = parseXmlAttributes(itemNode.attrsText);
      const attrs = normalizeAttributes(rawItemAttrs, { cash: 0, cost: 0 });
      const childrenXml =
        itemNode.endTagStart === null
          ? ''
          : xml.slice(itemNode.startTagEnd, itemNode.endTagStart).trim();

      items.push({
        group: groupName,
        attributes: attrs,
        childrenXml,
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
