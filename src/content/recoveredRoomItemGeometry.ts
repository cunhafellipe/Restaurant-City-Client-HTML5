import contract from '../../contracts/restaurant-city/recovered-room-item-geometry.json';

export interface RecoveredRoomItemFrame {
  readonly rotation: number;
  readonly visualFrameIndex?: number;
  readonly frame: string;
  readonly canvasOriginPx: {
    readonly x: number;
    readonly y: number;
  };
}

export interface RecoveredOccupiedCellRotation {
  readonly rotation: number;
  readonly cells: readonly {
    readonly x: number;
    readonly y: number;
  }[];
}

export interface RecoveredRoomItemGeometry {
  readonly className: string;
  readonly itemIds: readonly number[];
  readonly runtimeClassName: string | null;
  readonly rotationCount: number | null;
  readonly visualFrameCount: number | null;
  readonly occupiedCellsByRotation: readonly RecoveredOccupiedCellRotation[];
  readonly footprint: {
    readonly sizeX: number;
    readonly sizeY: number;
  };
  readonly itemHeightTwips: number;
  readonly placementFootprintEnabled: boolean;
  readonly frames: readonly RecoveredRoomItemFrame[];
}

interface ContractEntry {
  readonly itemIds: readonly number[];
  readonly runtimeClassName?: string;
  readonly rotationCount?: number;
  readonly visualFrameCount?: number;
  readonly occupiedCellsByRotation?: readonly RecoveredOccupiedCellRotation[];
  readonly footprint: {
    readonly sizeX: number;
    readonly sizeY: number;
  };
  readonly itemHeightTwips: number;
  readonly placementFootprintEnabled?: boolean;
  readonly frames?: readonly RecoveredRoomItemFrame[];
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
    runtimeClassName: entry.runtimeClassName ?? null,
    rotationCount: entry.rotationCount ?? null,
    visualFrameCount: entry.visualFrameCount ?? null,
    occupiedCellsByRotation: entry.occupiedCellsByRotation ?? [],
    footprint: entry.footprint,
    itemHeightTwips: entry.itemHeightTwips,
    placementFootprintEnabled: entry.placementFootprintEnabled === true,
    frames: entry.frames ?? [],
  };
}

export function recoveredPlacementFootprint(
  itemId: number,
  className: string | null,
): RecoveredRoomItemGeometry['footprint'] | null {
  const geometry = recoveredRoomItemGeometry(itemId, className);
  return geometry?.placementFootprintEnabled ? geometry.footprint : null;
}


export function recoveredRoomItemFrame(
  itemId: number,
  className: string | null,
  rotation: number,
): RecoveredRoomItemFrame | null {
  const geometry = recoveredRoomItemGeometry(itemId, className);
  if (!geometry || !Number.isInteger(rotation) || rotation < 0) return null;
  return (
    geometry.frames.find((frame) => frame.rotation === rotation) ?? null
  );
}

export function recoveredRoomItemFrameOffset(
  itemId: number,
  className: string | null,
  rotation: number,
): RecoveredRoomItemFrame['canvasOriginPx'] | null {
  return recoveredRoomItemFrame(itemId, className, rotation)?.canvasOriginPx ?? null;
}

export function recoveredRoomItemRuntimeClassName(
  itemId: number,
  className: string | null,
): string | null {
  return recoveredRoomItemGeometry(itemId, className)?.runtimeClassName ?? null;
}

export function recoveredRoomItemLogicalRotationCount(
  itemId: number,
  className: string | null,
): number | null {
  return recoveredRoomItemGeometry(itemId, className)?.rotationCount ?? null;
}

export function recoveredRoomItemOccupiedCells(
  itemId: number,
  className: string | null,
  rotation: number,
): readonly { readonly x: number; readonly y: number }[] | null {
  const geometry = recoveredRoomItemGeometry(itemId, className);
  if (!geometry || !Number.isInteger(rotation) || rotation < 0) return null;
  const recovered = geometry.occupiedCellsByRotation.find(
    (entry) => entry.rotation === rotation,
  );
  return recovered?.cells ?? null;
}
