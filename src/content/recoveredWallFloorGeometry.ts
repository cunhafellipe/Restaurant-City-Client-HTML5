import contract from '../../contracts/restaurant-city/recovered-wall-floor-geometry.json';

export interface RecoveredDoorMaskRaster {
  readonly frame: string;
  readonly canvasOriginPx: {
    readonly x: number;
    readonly y: number;
  };
  readonly atlasSize: {
    readonly width: number;
    readonly height: number;
  };
}

export interface RecoveredWallFloorGeometry {
  readonly className: string;
  readonly itemIds: readonly number[];
  readonly footprint: {
    readonly sizeX: number;
    readonly sizeY: number;
  } | null;
  readonly itemHeightTwips: number | null;
  readonly serverCatalogEnabled: boolean;
  readonly runtimeGeometryEnabled: boolean;
  readonly localBounds: {
    readonly leftPx: number;
    readonly rightPx: number;
    readonly topPx: number;
    readonly bottomPx: number;
    readonly widthPx: number;
    readonly heightPx: number;
  } | null;
  readonly rotationFrames: readonly {
    readonly rotation: number;
    readonly frame: string;
    readonly canvasOriginPx: {
      readonly x: number;
      readonly y: number;
    };
  }[];
  readonly maskRaster: RecoveredDoorMaskRaster | null;
}

interface ContractEntry {
  readonly itemIds: readonly number[];
  readonly footprint?: {
    readonly sizeX: number;
    readonly sizeY: number;
  } | null;
  readonly itemHeightTwips?: number | null;
  readonly serverCatalogEnabled?: boolean;
  readonly runtimeGeometryEnabled?: boolean;
  readonly localBounds?: {
    readonly leftPx: number;
    readonly rightPx: number;
    readonly topPx: number;
    readonly bottomPx: number;
    readonly widthPx: number;
    readonly heightPx: number;
  } | null;
  readonly rotationFrames?: readonly {
    readonly rotation: number;
    readonly frame: string;
    readonly canvasOriginPx: {
      readonly x: number;
      readonly y: number;
    };
  }[];
  readonly mask?: {
    readonly raster?: RecoveredDoorMaskRaster;
  };
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
    runtimeGeometryEnabled: entry.runtimeGeometryEnabled === true,
    localBounds: entry.localBounds ?? null,
    rotationFrames: entry.rotationFrames ?? [],
    maskRaster: entry.mask?.raster ?? null,
  };
}

export function recoveredEnabledWallFloorFootprint(
  itemId: number,
  className: string | null,
): NonNullable<RecoveredWallFloorGeometry['footprint']> | null {
  const geometry = recoveredWallFloorGeometry(itemId, className);
  return geometry?.runtimeGeometryEnabled || geometry?.serverCatalogEnabled
    ? geometry.footprint
    : null;
}

export function recoveredWallFloorFrameOffset(
  itemId: number,
  className: string | null,
  rotation: number,
): { readonly x: number; readonly y: number } | null {
  const geometry = recoveredWallFloorGeometry(itemId, className);
  if (
    !geometry ||
    (!geometry.runtimeGeometryEnabled && !geometry.serverCatalogEnabled)
  ) {
    return null;
  }

  const frame = geometry.rotationFrames.find(
    (candidate) => candidate.rotation === rotation,
  );
  if (frame) return frame.canvasOriginPx;

  if (rotation === 0 && geometry.localBounds) {
    return {
      x: geometry.localBounds.leftPx,
      y: geometry.localBounds.topPx,
    };
  }
  return null;
}

export function recoveredDoorMaskRaster(
  itemId: number,
  className: string | null,
): RecoveredDoorMaskRaster | null {
  const geometry = recoveredWallFloorGeometry(itemId, className);
  if (
    !geometry ||
    (!geometry.runtimeGeometryEnabled && !geometry.serverCatalogEnabled)
  ) {
    return null;
  }
  return geometry.maskRaster;
}

