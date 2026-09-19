import contract from '../../contracts/restaurant-city/recovered-wall-floor-geometry.json';

export interface RecoveredWallFloorGeometry {
  readonly className: string;
  readonly itemIds: readonly number[];
  readonly footprint: {
    readonly sizeX: number;
    readonly sizeY: number;
  } | null;
  readonly itemHeightTwips: number | null;
  readonly serverCatalogEnabled: boolean;
}

interface ContractEntry {
  readonly itemIds: readonly number[];
  readonly footprint?: {
    readonly sizeX: number;
    readonly sizeY: number;
  } | null;
  readonly itemHeightTwips?: number | null;
  readonly serverCatalogEnabled?: boolean;
}

const entries = Object.entries(contract.classes) as ReadonlyArray<
  readonly [string, ContractEntry]
>;

function leafClassName(value: string | null): string | null {
  if (!value) return null;
  return value.split(/[.:]/).at(-1) ?? null;
}

export function recoveredWallFloorGeometry(
  itemId: number,
  className: string | null,
): RecoveredWallFloorGeometry | null {
  const leaf = leafClassName(className);
  if (!leaf) return null;

  const match = entries.find(
    ([candidateClass, entry]) =>
      candidateClass === leaf && entry.itemIds.includes(itemId),
  );
  if (!match) return null;

  const [matchedClass, entry] = match;
  return {
    className: matchedClass,
    itemIds: entry.itemIds,
    footprint: entry.footprint ?? null,
    itemHeightTwips: entry.itemHeightTwips ?? null,
    serverCatalogEnabled: entry.serverCatalogEnabled === true,
  };
}

export function recoveredEnabledWallFloorFootprint(
  itemId: number,
  className: string | null,
): NonNullable<RecoveredWallFloorGeometry['footprint']> | null {
  const geometry = recoveredWallFloorGeometry(itemId, className);
  return geometry?.serverCatalogEnabled ? geometry.footprint : null;
}
