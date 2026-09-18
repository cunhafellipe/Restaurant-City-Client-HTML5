import { describe, expect, it } from 'vitest';
import {
  requireContentFile,
  resolveContentLayers,
  type ContentLayer,
} from '../../src/content/catalog';
import { CANONICAL_09143A_LAYER } from '../../src/content/baseline';

describe('content layers', () => {
  it('keeps canonical families when a later layer does not replace them', () => {
    const later: ContentLayer = {
      id: 'historical-2.21.2',
      gameVersion: '2.21.2',
      precedence: 2212,
      confidence: 'validated-historical',
      provenance: 'fixture',
      files: [{ family: 'restaurant', url: '/content/2.21.2/restaurant.bin' }],
    };

    const catalog = resolveContentLayers([later, CANONICAL_09143A_LAYER]);

    expect(requireContentFile(catalog, 'restaurant').gameVersion).toBe('2.21.2');
    expect(requireContentFile(catalog, 'recipe').gameVersion).toBe('0.9.143a');
  });

  it('does not allow reference-only evidence to override validated bytes', () => {
    const reference: ContentLayer = {
      id: 'reference-2.31.2',
      gameVersion: '2.31.2',
      precedence: 2312,
      confidence: 'reference-only',
      provenance: 'version evidence only',
      files: [{ family: 'restaurant', url: '/unvalidated/restaurant.bin' }],
    };

    const catalog = resolveContentLayers([
      CANONICAL_09143A_LAYER,
      reference,
    ]);

    expect(requireContentFile(catalog, 'restaurant').gameVersion).toBe(
      '0.9.143a',
    );
  });

  it('rejects ambiguous duplicate definitions inside one layer', () => {
    const invalid: ContentLayer = {
      id: 'bad',
      gameVersion: 'x',
      precedence: 999,
      confidence: 'validated-historical',
      provenance: 'fixture',
      files: [
        { family: 'quiz', url: '/a' },
        { family: 'quiz', url: '/b' },
      ],
    };

    expect(() => resolveContentLayers([invalid])).toThrow(
      /defines family quiz more than once/,
    );
  });
});
