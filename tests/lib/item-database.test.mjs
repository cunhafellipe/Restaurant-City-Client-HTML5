import { describe, expect, it } from 'vitest';
import {
  legacyAttributeValue,
  parseItemDatabaseXml,
  parseXmlAttributes,
} from '../../tools/lib/item-database.mjs';

describe('historical ItemDatabase parser', () => {
  it('decodes XML entities in attributes', () => {
    expect(
      parseXmlAttributes('name="Fish &amp; Chips" note="A&#x20;B"'),
    ).toEqual({ name: 'Fish & Chips', note: 'A B' });
  });

  it('matches ItemDatabase.as attribute coercions', () => {
    expect(legacyAttributeValue('type', 'table, decor , kitchen')).toEqual([
      'table',
      'decor',
      'kitchen',
    ]);
    expect(legacyAttributeValue('enabled', 'true')).toBe(true);
    expect(legacyAttributeValue('enabled', 'false')).toBe(false);
    expect(legacyAttributeValue('asset', 'null')).toBeNull();
    expect(legacyAttributeValue('cost', '250')).toBe('250');
  });

  it('preserves group/item semantics and defaults cash/cost to zero', () => {
    const db = parseItemDatabaseXml(`
      <items>
        <group name="tables" type="decor,table" outdoor="false">
          <item id="10" name="basic_table" sizeX="2" sizeY="1"/>
          <item id="11" name="special" cash="3" type="unique">
            <function name="bonus"/>
          </item>
        </group>
      </items>
    `);

    expect(db.counts).toEqual({ groups: 1, items: 2 });
    expect(db.groups[0]?.attributes.type).toEqual(['decor', 'table']);
    expect(db.groups[0]?.attributes.outdoor).toBe(false);

    expect(db.groups[0]?.items[0]?.attributes).toMatchObject({
      cash: 0,
      cost: 0,
      id: '10',
      name: 'basic_table',
      sizeX: '2',
      sizeY: '1',
    });
    expect(db.groups[0]?.items[1]?.attributes.cash).toBe('3');
    expect(db.groups[0]?.items[1]?.attributes.type).toEqual(['unique']);
    expect(db.groups[0]?.items[1]?.childrenXml).toContain('<function');
  });

  it('keeps duplicate ids because the original loader only warns about them', () => {
    const db = parseItemDatabaseXml(`
      <items>
        <group name="a"><item id="1" name="x"/></group>
        <group name="b"><item id="1" name="y"/></group>
      </items>
    `);
    expect(db.counts.items).toBe(2);
  });
});
