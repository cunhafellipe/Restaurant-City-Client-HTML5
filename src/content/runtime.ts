export interface RuntimeDataEntry {
  readonly id: string;
  readonly xml: string;
  readonly itemDatabase: string | null;
  readonly source: string;
  readonly sourceSha256: string;
  readonly decodedSha256: string;
  readonly rightsClass: string;
  readonly releaseEligible: boolean;
}

export interface RuntimeAudioEntry {
  readonly id: string;
  readonly file: string;
  readonly format: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly source: string;
  readonly rightsClass: string;
  readonly releaseEligible: boolean;
}

export interface RuntimeAtlasEntry {
  readonly id: string;
  readonly json: string;
  readonly files: readonly string[];
  readonly source: string;
}

export interface RuntimeManifest {
  readonly version: 3;
  readonly baseline: string;
  readonly atlases: readonly RuntimeAtlasEntry[];
  readonly audio: readonly RuntimeAudioEntry[];
  readonly data: readonly RuntimeDataEntry[];
  readonly langs: readonly {
    readonly code: string;
    readonly xml: string;
    readonly itemDatabase: string | null;
  }[];
  readonly coverage: Readonly<
    Record<
      string,
      {
        readonly symbols: number;
        readonly exported: number;
        readonly frames: number;
        readonly pct: number;
        readonly pages: number;
      }
    >
  >;
}

export type LegacyAttributeValue =
  | string
  | number
  | boolean
  | null
  | readonly string[];

export interface GeneratedItem {
  readonly group: string;
  readonly attributes: Readonly<Record<string, LegacyAttributeValue>>;
  readonly childrenXml: string;
}

export interface GeneratedItemGroup {
  readonly name: string;
  readonly attributes: Readonly<Record<string, LegacyAttributeValue>>;
  readonly items: readonly GeneratedItem[];
}

export interface GeneratedItemDatabase {
  readonly schemaVersion: 1;
  readonly groups: readonly GeneratedItemGroup[];
  readonly counts: {
    readonly groups: number;
    readonly items: number;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateRuntimeManifest(value: unknown): RuntimeManifest {
  if (!isObject(value) || value.version !== 3) {
    throw new Error('Unsupported or malformed Restaurant City runtime manifest');
  }
  if (typeof value.baseline !== 'string' || !Array.isArray(value.data)) {
    throw new Error('Runtime manifest is missing baseline/data');
  }
  if (
    !Array.isArray(value.atlases) ||
    !Array.isArray(value.audio) ||
    !Array.isArray(value.langs) ||
    !isObject(value.coverage)
  ) {
    throw new Error('Runtime manifest sections are malformed');
  }
  return value as unknown as RuntimeManifest;
}

export async function loadRuntimeManifest(
  url = '/assets/generated/manifest.json',
  fetcher: typeof fetch = fetch,
): Promise<RuntimeManifest> {
  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(
      `Failed to load Restaurant City runtime manifest: HTTP ${response.status}`,
    );
  }
  return validateRuntimeManifest(await response.json());
}

export function requireRuntimeData(
  manifest: RuntimeManifest,
  family: string,
): RuntimeDataEntry {
  const entry = manifest.data.find((candidate) => candidate.id === family);
  if (!entry) {
    throw new Error(`Runtime data family not present: ${family}`);
  }
  return entry;
}

export async function loadGeneratedItemDatabase(
  manifest: RuntimeManifest,
  family: string,
  fetcher: typeof fetch = fetch,
): Promise<GeneratedItemDatabase> {
  const entry = requireRuntimeData(manifest, family);
  if (!entry.itemDatabase) {
    throw new Error(`Runtime data family ${family} is not an ItemDatabase`);
  }
  const response = await fetcher(
    `/assets/generated/${entry.itemDatabase.replace(/^\/+/, '')}`,
  );
  if (!response.ok) {
    throw new Error(
      `Failed to load item database ${family}: HTTP ${response.status}`,
    );
  }
  const value: unknown = await response.json();
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.groups) ||
    !isObject(value.counts) ||
    typeof value.counts.groups !== 'number' ||
    typeof value.counts.items !== 'number'
  ) {
    throw new Error(`Malformed generated ItemDatabase: ${family}`);
  }
  return value as unknown as GeneratedItemDatabase;
}
