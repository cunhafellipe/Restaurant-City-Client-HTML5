import { TILE_HEIGHT_HALF, TILE_WIDTH_HALF, type Footprint } from '../core/restaurantGrid';
import type { RestaurantItemDefinition } from './items';
import { recoveredRoomItemGeometry } from './recoveredRoomItemGeometry';

const SYSTEM_ONLY_GROUPS = new Set(['Visit', 'OutsideAreaSize']);

export interface RuntimeAtlasFrames {
  readonly atlasId: string;
  readonly frameNames: readonly string[];
}

export interface RestaurantItemVisual {
  readonly atlasId: string;
  readonly symbol: string;
  readonly frames: readonly string[];
}

export type RestaurantItemVisualIndex = ReadonlyMap<
  string,
  readonly RestaurantItemVisual[]
>;

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function leafClassName(value: string | null): string | null {
  if (!value) return null;
  const parts = value.split(/[.:]/);
  return parts.at(-1) || null;
}

export function isSystemOnlyRestaurantItem(
  item: Pick<RestaurantItemDefinition, 'group'>,
): boolean {
  return SYSTEM_ONLY_GROUPS.has(item.group);
}

export function buildRestaurantItemVisualIndex(
  atlases: readonly RuntimeAtlasFrames[],
): RestaurantItemVisualIndex {
  const mutable = new Map<
    string,
    Map<string, { atlasId: string; symbol: string; frames: Set<string> }>
  >();

  for (const atlas of atlases) {
    for (const frameName of atlas.frameNames) {
      const parts = frameName.split('/');
      if (parts.length < 3 || !parts[0] || !parts[1]) {
        throw new Error(`Malformed Restaurant City atlas frame key: ${frameName}`);
      }
      if (parts[0] !== atlas.atlasId) {
        throw new Error(
          `Atlas frame ${frameName} does not belong to texture ${atlas.atlasId}`,
        );
      }

      const symbol = normalize(parts[1]);
      let byAtlas = mutable.get(symbol);
      if (!byAtlas) {
        byAtlas = new Map();
        mutable.set(symbol, byAtlas);
      }

      let candidate = byAtlas.get(atlas.atlasId);
      if (!candidate) {
        candidate = {
          atlasId: atlas.atlasId,
          symbol,
          frames: new Set<string>(),
        };
        byAtlas.set(atlas.atlasId, candidate);
      }
      candidate.frames.add(frameName);
    }
  }

  return new Map(
    [...mutable.entries()].map(([symbol, byAtlas]) => [
      symbol,
      [...byAtlas.values()]
        .map((candidate) => ({
          atlasId: candidate.atlasId,
          symbol: candidate.symbol,
          frames: [...candidate.frames].sort(),
        }))
        .sort((a, b) => a.atlasId.localeCompare(b.atlasId)),
    ]),
  );
}

/**
 * Resolve the original linked RoomItem symbol without guessing.
 *
 * The recovered client constructs RoomItem from itemConfig.className. We only
 * fall through to lower-confidence historical aliases when the higher-priority
 * key has no exact symbol at all; this is what makes SkunkItem deterministic
 * instead of being made ambiguous by the display name "Skunk".
 */
export function resolveRestaurantItemVisual(
  item: Pick<
    RestaurantItemDefinition,
    'id' | 'name' | 'group' | 'className' | 'hash'
  >,
  index: RestaurantItemVisualIndex,
): RestaurantItemVisual | null {
  if (isSystemOnlyRestaurantItem(item)) return null;

  const recovered = recoveredRoomItemGeometry(item.id, item.className);
  if (
    recovered?.runtimeClassName &&
    recovered.rotationCount !== null &&
    recovered.rotationCount > 0 &&
    recovered.frames.length === recovered.rotationCount
  ) {
    const runtimeKey = normalize(recovered.runtimeClassName);
    const matches = index.get(runtimeKey) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        `Restaurant City item #${item.id} recovered runtime class ${recovered.runtimeClassName} resolved to ${matches.length} atlas symbols`,
      );
    }
    const candidate = matches[0]!;
    const available = new Set(candidate.frames);
    const logicalFrames = [...recovered.frames]
      .sort((a, b) => a.rotation - b.rotation)
      .map((frame, rotation) => {
        if (frame.rotation !== rotation || !available.has(frame.frame)) {
          throw new Error(
            `Restaurant City item #${item.id} recovered runtime frame contract is inconsistent at rotation ${rotation}`,
          );
        }
        return frame.frame;
      });
    if (
      recovered.visualFrameCount !== null &&
      new Set(logicalFrames).size !== recovered.visualFrameCount
    ) {
      throw new Error(
        `Restaurant City item #${item.id} recovered visual/logical rotation contract is inconsistent`,
      );
    }
    return {
      atlasId: candidate.atlasId,
      symbol: runtimeKey,
      frames: logicalFrames,
    };
  }

  const strategies = [
    item.className,
    leafClassName(item.className),
    item.hash,
    item.name,
  ];

  const seen = new Set<string>();
  for (const raw of strategies) {
    const key = normalize(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const matches = index.get(key) ?? [];
    if (matches.length === 0) continue;
    if (matches.length > 1) {
      throw new Error(
        `Restaurant City item #${item.id} key ${raw} resolves to multiple atlas symbols`,
      );
    }
    const visual = matches[0]!;
    if (visual.frames.length === 0 || visual.frames.length > 16) {
      throw new Error(
        `Restaurant City item #${item.id} has invalid historical frame count ${visual.frames.length}`,
      );
    }
    return visual;
  }

  return null;
}

/**
 * RoomItem.rotate() advances content.nextFrame(), and getMaxRotationCount()
 * returns content.totalFrames in the recovered ActionScript client.
 */
export function frameForRestaurantItemRotation(
  visual: RestaurantItemVisual,
  rotation: number,
): string {
  if (
    !Number.isInteger(rotation) ||
    rotation < 0 ||
    rotation >= visual.frames.length
  ) {
    throw new Error(
      `Rotation ${rotation} is invalid for ${visual.atlasId}/${visual.symbol} with ${visual.frames.length} historical frame(s)`,
    );
  }
  return visual.frames[rotation]!;
}

export interface HistoricalFrameOffset {
  readonly x: number;
  readonly y: number;
}

/**
 * FFDec exports the rendered sprite bounds as a cropped PNG. The historical
 * RoomItem constructor derives its footprint from bounds.right/40 and
 * bounds.bottom/20. Inverting that recovered relationship restores the Flash
 * local origin from a frame's raster dimensions without inventing per-item
 * anchors.
 */
export function historicalRoomItemFrameOffset(
  footprint: Footprint,
  frameWidth: number,
  frameHeight: number,
): HistoricalFrameOffset {
  if (
    !Number.isFinite(frameWidth) ||
    !Number.isFinite(frameHeight) ||
    frameWidth <= 0 ||
    frameHeight <= 0
  ) {
    throw new Error('Restaurant City frame dimensions must be positive');
  }
  return {
    x: footprint.sizeX * TILE_WIDTH_HALF - frameWidth,
    y:
      (footprint.sizeX + footprint.sizeY) * TILE_HEIGHT_HALF -
      frameHeight,
  };
}
