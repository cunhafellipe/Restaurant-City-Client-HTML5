import type { ContentLayer } from './catalog';

/**
 * Canonical Dippys/n3r0-equivalent 0.9.143a data baseline.
 *
 * These URLs deliberately point at the existing backend surface. Historical
 * bytes remain outside Git; the runtime receives them from the local server.
 */
export const CANONICAL_09143A_LAYER: ContentLayer = {
  id: 'canonical-0.9.143a',
  gameVersion: '0.9.143a',
  precedence: 100,
  confidence: 'canonical-baseline',
  provenance:
    'ANEWON P1: 24/24 content-equivalent to the pinned historical 0.9.143a corpus',
  files: [
    { family: 'ingredient', url: '/bin-xml/ingredient.bin' },
    { family: 'recipe', url: '/bin-xml/recipe.bin' },
    { family: 'model', url: '/bin-xml/model.bin' },
    { family: 'avatar', url: '/bin-xml/avatar.bin' },
    { family: 'perk', url: '/bin-xml/perk.bin' },
    { family: 'quiz', url: '/bin-xml/quiz.bin' },
    { family: 'challenge', url: '/bin-xml/challenge.bin' },
    { family: 'restaurant', url: '/bin-xml/restaurant.bin' },
    { family: 'front', url: '/bin-xml/front.bin' },
    { family: 'appointment', url: '/bin-xml/appointment.bin' },
    { family: 'lang_en', url: '/bin-xml/lang_en.bin' },
    { family: 'lang_fr', url: '/bin-xml/lang_fr.bin' },
    { family: 'newsletter', url: '/bin-xml/newsletter.xml' },
    { family: 'resconfig', url: '/bin-xml/resconfig.xml' },
  ],
};

/**
 * Additional validated historical layers are generated locally from the Vault
 * and appended here (or loaded from a generated manifest) without mutating the
 * canonical beta layer.
 */
export const DEFAULT_CONTENT_STACK: readonly ContentLayer[] = [
  CANONICAL_09143A_LAYER,
];
