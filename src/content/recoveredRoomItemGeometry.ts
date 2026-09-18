import contract from '../../contracts/restaurant-city/recovered-room-item-geometry.json';

export interface RecoveredRoomItemGeometry {
  readonly className: string;
  readonly itemIds: readonly number[];
  readonly footprint: {
    readonly sizeX: number;
    readonly sizeY: number;
  };
  readonly itemHeightTwips: number;
  readonly placementFootprintEnabled: boolean;
}

interface ContractEntry {
  readonly itemIds: readonly number[];
  readonly footprint: {
    readonly sizeX: number;
    readonly sizeY: number;
  };
  readonly itemHeightTwips: number;
  readonly placementFootprintEnabled?: boolean;
}

const entries = Object.entries(contract.classes) as ReadonlyArray<
  readonly [string, ContractEntry]
>;

function leafClassName(value: string | null): string | null {
  if (!value) return null;
  const parts = value.split(/[.:]/);
  return parts.at(-1) ?? null;
}

export function recoveredRoomItemGeometry(
  itemId: number,
  className: string | null,
): RecoveredRoomItemGeometry | null {
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
    footprint: entry.footprint,
    itemHeightTwips: entry.itemHeightTwips,
    placementFootprintEnabled: entry.placementFootprintEnabled === true,
  };
}

export function recoveredPlacementFootprint(
  itemId: number,
  className: string | null,
): RecoveredRoomItemGeometry['footprint'] | null {
  const geometry = recoveredRoomItemGeometry(itemId, className);
  return geometry?.placementFootprintEnabled ? geometry.footprint : null;
}
