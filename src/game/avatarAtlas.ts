import type { RecoveredAvatarAnimationName } from './avatarPresentation';

export interface AvatarAtlasFrameRuntime {
  readonly animation: string;
  readonly animationId: number;
  readonly physicalDirection: number;
  readonly historicalFrame: number;
  readonly blenderFrame: number;
  readonly crop: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly anchorPx: {
    readonly x: number;
    readonly y: number;
  };
}

export interface AvatarAtlasDirectionRuntime {
  readonly physicalDirection: number;
  readonly flipX: boolean;
  readonly frameKeys: readonly string[];
}

export interface AvatarAtlasAnimationRuntime {
  readonly id: number;
  readonly frameDelayMs: number;
  readonly directions: Readonly<Record<string, AvatarAtlasDirectionRuntime>>;
}

export interface AvatarAtlasRuntimeDescriptor {
  readonly schemaVersion: 1;
  readonly baseline: string;
  readonly atlasKey: 'restaurant-avatar-placeholder';
  readonly atlasJson: string;
  readonly physicalFrameCount: number;
  readonly sourceViewport: {
    readonly width: 760;
    readonly height: 600;
  };
  readonly actorOriginViewport: {
    readonly x: 380;
    readonly y: 300;
  };
  readonly tileHeightHalfPx: 20;
  readonly animations: Readonly<Record<string, AvatarAtlasAnimationRuntime>>;
  readonly frames: Readonly<Record<string, AvatarAtlasFrameRuntime>>;
}

export interface ResolvedAvatarAtlasFrame {
  readonly frameKey: string;
  readonly flipX: boolean;
  readonly anchorPx: {
    readonly x: number;
    readonly y: number;
  };
  readonly frameDelayMs: number;
  readonly logicalDirection: number;
  readonly physicalDirection: number;
}

function requireFiniteInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${label} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

export function parseAvatarAtlasRuntime(
  value: unknown,
): AvatarAtlasRuntimeDescriptor {
  if (!value || typeof value !== 'object') {
    throw new Error('avatar runtime descriptor must be an object');
  }

  const candidate = value as Partial<AvatarAtlasRuntimeDescriptor>;
  if (candidate.schemaVersion !== 1) {
    throw new Error('avatar runtime descriptor schema must be 1');
  }
  if (candidate.atlasKey !== 'restaurant-avatar-placeholder') {
    throw new Error('avatar runtime descriptor atlas key drifted');
  }
  if (
    candidate.sourceViewport?.width !== 760 ||
    candidate.sourceViewport.height !== 600 ||
    candidate.actorOriginViewport?.x !== 380 ||
    candidate.actorOriginViewport.y !== 300 ||
    candidate.tileHeightHalfPx !== 20
  ) {
    throw new Error('avatar runtime descriptor historical viewport drifted');
  }
  if (candidate.physicalFrameCount !== 98) {
    throw new Error('avatar runtime descriptor must contain 98 physical frames');
  }
  if (!candidate.animations || !candidate.frames) {
    throw new Error('avatar runtime descriptor is missing animations/frames');
  }

  const frameEntries = Object.entries(candidate.frames);
  if (frameEntries.length !== 98) {
    throw new Error(
      `avatar runtime descriptor frame map has ${frameEntries.length}; expected 98`,
    );
  }

  for (const [key, frame] of frameEntries) {
    if (!frame || frame.animation.length === 0) {
      throw new Error(`avatar frame ${key} has invalid animation metadata`);
    }
    requireFiniteInteger(frame.animationId, `${key}.animationId`, 0, 64);
    requireFiniteInteger(
      frame.physicalDirection,
      `${key}.physicalDirection`,
      0,
      4,
    );
    requireFiniteInteger(frame.historicalFrame, `${key}.historicalFrame`, 0, 348);
    if (
      !Number.isFinite(frame.blenderFrame) ||
      !Number.isFinite(frame.anchorPx.x) ||
      !Number.isFinite(frame.anchorPx.y) ||
      frame.crop.width <= 0 ||
      frame.crop.height <= 0
    ) {
      throw new Error(`avatar frame ${key} has invalid geometry metadata`);
    }
  }

  return candidate as AvatarAtlasRuntimeDescriptor;
}

export function resolveAvatarAtlasFrame(
  descriptor: AvatarAtlasRuntimeDescriptor,
  animation: Exclude<RecoveredAvatarAnimationName, 'hidden'>,
  logicalDirection: number,
  animationFrameIndex: number,
): ResolvedAvatarAtlasFrame {
  requireFiniteInteger(logicalDirection, 'logicalDirection', 0, 7);
  if (!Number.isInteger(animationFrameIndex) || animationFrameIndex < 0) {
    throw new Error('animationFrameIndex must be a non-negative integer');
  }

  const animationRuntime = descriptor.animations[animation];
  if (!animationRuntime) {
    throw new Error(`avatar animation ${animation} is missing from runtime descriptor`);
  }
  const direction = animationRuntime.directions[String(logicalDirection)];
  if (!direction) {
    throw new Error(
      `avatar animation ${animation} has no recovered direction ${logicalDirection}`,
    );
  }
  if (direction.frameKeys.length === 0) {
    throw new Error(
      `avatar animation ${animation} direction ${logicalDirection} has no frames`,
    );
  }

  const frameKey =
    direction.frameKeys[animationFrameIndex % direction.frameKeys.length];
  if (!frameKey) {
    throw new Error('avatar frame resolution unexpectedly produced no key');
  }
  const frame = descriptor.frames[frameKey];
  if (!frame) {
    throw new Error(`avatar runtime frame ${frameKey} is missing`);
  }
  if (
    frame.animation !== animation ||
    frame.physicalDirection !== direction.physicalDirection
  ) {
    throw new Error(
      `avatar runtime frame ${frameKey} disagrees with animation/direction map`,
    );
  }

  return {
    frameKey,
    flipX: direction.flipX,
    anchorPx: { ...frame.anchorPx },
    frameDelayMs: animationRuntime.frameDelayMs,
    logicalDirection,
    physicalDirection: direction.physicalDirection,
  };
}
