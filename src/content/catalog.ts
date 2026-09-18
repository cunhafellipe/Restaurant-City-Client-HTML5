export type ContentFamily =
  | 'ingredient'
  | 'recipe'
  | 'model'
  | 'avatar'
  | 'perk'
  | 'quiz'
  | 'challenge'
  | 'challenges'
  | 'restaurant'
  | 'front'
  | 'appointment'
  | 'level_up'
  | 'lang_en'
  | 'lang_fr'
  | 'newsletter'
  | 'resconfig';

export type ContentConfidence =
  | 'canonical-baseline'
  | 'validated-historical'
  | 'reference-only';

export interface ContentFile {
  readonly family: ContentFamily;
  readonly url: string;
  readonly sha256?: string;
  readonly sourceLabel?: string;
}

export interface ContentLayer {
  /** Stable identifier; never reuse for different bytes. */
  readonly id: string;
  readonly gameVersion: string;
  /** Higher precedence overrides the same family from lower layers. */
  readonly precedence: number;
  readonly confidence: ContentConfidence;
  readonly provenance: string;
  readonly files: readonly ContentFile[];
}

export interface ResolvedContentFile extends ContentFile {
  readonly layerId: string;
  readonly gameVersion: string;
  readonly confidence: ContentConfidence;
  readonly provenance: string;
}

export interface ResolvedContentCatalog {
  readonly layers: readonly ContentLayer[];
  readonly files: ReadonlyMap<ContentFamily, ResolvedContentFile>;
}

/**
 * Resolves a deterministic Restaurant City content stack.
 *
 * The Dippys/canonical beta corpus can remain the immutable bottom layer while
 * independently validated historical datasets are added above it. A later
 * layer only replaces families it actually contains; everything else falls
 * through to the baseline.
 */
export function resolveContentLayers(
  inputLayers: readonly ContentLayer[],
): ResolvedContentCatalog {
  const layers = [...inputLayers].sort(
    (a, b) => a.precedence - b.precedence || a.id.localeCompare(b.id),
  );

  const seenLayerIds = new Set<string>();
  const files = new Map<ContentFamily, ResolvedContentFile>();

  for (const layer of layers) {
    if (seenLayerIds.has(layer.id)) {
      throw new Error(`Duplicate content layer id: ${layer.id}`);
    }
    seenLayerIds.add(layer.id);

    const seenFamilies = new Set<ContentFamily>();
    for (const file of layer.files) {
      if (seenFamilies.has(file.family)) {
        throw new Error(
          `Layer ${layer.id} defines family ${file.family} more than once`,
        );
      }
      seenFamilies.add(file.family);

      if (layer.confidence === 'reference-only') {
        continue;
      }

      files.set(file.family, {
        ...file,
        layerId: layer.id,
        gameVersion: layer.gameVersion,
        confidence: layer.confidence,
        provenance: layer.provenance,
      });
    }
  }

  return { layers, files };
}

export function requireContentFile(
  catalog: ResolvedContentCatalog,
  family: ContentFamily,
): ResolvedContentFile {
  const file = catalog.files.get(family);
  if (!file) {
    throw new Error(`No validated content file registered for ${family}`);
  }
  return file;
}
