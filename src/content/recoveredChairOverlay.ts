import contract from '../../contracts/restaurant-city/recovered-chair-overlays.json';

export interface RecoveredChairOverlayRotation {
  readonly rotation: number;
  readonly visible: boolean;
  readonly frame: string | null;
  readonly canvasOriginPx: {
    readonly x: number;
    readonly y: number;
  } | null;
}

interface OverlayContractEntry {
  readonly itemIds: readonly number[];
  readonly overlayClassName: string;
  readonly logicalRotationCount: number;
  readonly visibleFrameCount: number;
  readonly rotations: readonly RecoveredChairOverlayRotation[];
}

const entries = Object.entries(contract.overlays) as ReadonlyArray<
  readonly [string, OverlayContractEntry]
>;

function leafClassName(value: string | null): string | null {
  if (!value) return null;
  const parts = value.split(/[.:]/);
  return parts.at(-1) ?? null;
}

export function recoveredChairOverlayRotation(
  itemId: number,
  className: string | null,
  rotation: number,
): RecoveredChairOverlayRotation | null {
  if (!Number.isInteger(rotation) || rotation < 0) {
    throw new Error('chair overlay rotation must be a non-negative integer');
  }

  const leaf = leafClassName(className);
  if (!leaf) return null;
  const match = entries.find(
    ([candidateClass, entry]) =>
      candidateClass === leaf && entry.itemIds.includes(itemId),
  );
  if (!match) return null;

  const [, entry] = match;
  if (
    entry.logicalRotationCount !== 4 ||
    entry.rotations.length !== entry.logicalRotationCount ||
    entry.visibleFrameCount !==
      entry.rotations.filter((candidate) => candidate.visible).length
  ) {
    throw new Error(
      `Recovered chair overlay contract is inconsistent for #${itemId}`,
    );
  }

  const candidate = entry.rotations.find(
    (frame) => frame.rotation === rotation,
  );
  if (!candidate) {
    throw new Error(
      `Recovered chair overlay has no logical rotation ${rotation} for #${itemId}`,
    );
  }
  if (
    candidate.visible !==
    (candidate.frame !== null && candidate.canvasOriginPx !== null)
  ) {
    throw new Error(
      `Recovered chair overlay visibility/raster mismatch for #${itemId} rotation ${rotation}`,
    );
  }

  return candidate;
}
