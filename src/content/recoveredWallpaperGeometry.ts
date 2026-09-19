import contract from '../../contracts/restaurant-city/recovered-wallpaper-geometry.json';

export interface RecoveredWallpaperFrame {
  readonly rotation: number;
  readonly frame: string;
  readonly canvasOriginPx: {
    readonly x: number;
    readonly y: number;
  };
}

export interface RecoveredWallpaperGeometry {
  readonly itemId: number;
  readonly className: string;
  readonly spriteId: number;
  readonly frames: readonly RecoveredWallpaperFrame[];
}

interface ContractItem {
  readonly itemId: number;
  readonly className: string;
  readonly spriteId: number;
  readonly frames: readonly RecoveredWallpaperFrame[];
}

const items = contract.items as readonly ContractItem[];

function leafClassName(value: string | null): string | null {
  if (!value) return null;
  return value.split(/[.:]/).at(-1) ?? null;
}

export function recoveredWallpaperGeometry(
  itemId: number,
  className: string | null,
): RecoveredWallpaperGeometry | null {
  const leaf = leafClassName(className);
  if (!leaf) return null;
  const item = items.find(
    (candidate) => candidate.itemId === itemId && candidate.className === leaf,
  );
  return item ?? null;
}

export function recoveredWallpaperFrame(
  itemId: number,
  className: string | null,
  rotation: number,
): RecoveredWallpaperFrame | null {
  const geometry = recoveredWallpaperGeometry(itemId, className);
  if (!geometry) return null;
  return (
    geometry.frames.find((candidate) => candidate.rotation === rotation) ?? null
  );
}

export function recoveredWallpaperFrameOffset(
  itemId: number,
  className: string | null,
  rotation: number,
): { readonly x: number; readonly y: number } | null {
  return recoveredWallpaperFrame(itemId, className, rotation)?.canvasOriginPx ?? null;
}

export function recoveredWallpaperItemIds(): readonly number[] {
  return items.map((item) => item.itemId);
}
