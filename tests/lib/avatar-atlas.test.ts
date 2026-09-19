import { describe, expect, it } from 'vitest';
import {
  parseAvatarAtlasRuntime,
  resolveAvatarAtlasFrame,
  type AvatarAtlasRuntimeDescriptor,
} from '../../src/game/avatarAtlas';
import {
  RECOVERED_AVATAR_ANIMATIONS,
  type RecoveredAvatarAnimationName,
} from '../../src/game/avatarPresentation';

function descriptor(): AvatarAtlasRuntimeDescriptor {
  const frames: Record<string, AvatarAtlasRuntimeDescriptor['frames'][string]> = {};
  const animations: Record<
    string,
    AvatarAtlasRuntimeDescriptor['animations'][string]
  > = {};

  for (const [name, animation] of Object.entries(
    RECOVERED_AVATAR_ANIMATIONS,
  )) {
    const directions: Record<
      string,
      AvatarAtlasRuntimeDescriptor['animations'][string]['directions'][string]
    > = {};

    for (const logicalDirection of animation.directions) {
      const physicalDirection =
        logicalDirection >= 5 ? 8 - logicalDirection : logicalDirection;
      const frameKeys: string[] = [];

      for (
        let historicalFrame = animation.frameStart;
        historicalFrame <= animation.frameEnd;
        historicalFrame += 1
      ) {
        const key =
          `avatar_service/${name}/d${physicalDirection}/f` +
          String(historicalFrame).padStart(3, '0');
        frameKeys.push(key);
        frames[key] ??= {
          animation: name,
          animationId: animation.id,
          physicalDirection,
          historicalFrame,
          blenderFrame: historicalFrame * 2.4,
          crop: { x: 350, y: 250, width: 60, height: 100 },
          anchorPx: { x: 30, y: 30 },
        };
      }

      directions[String(logicalDirection)] = {
        physicalDirection,
        flipX: logicalDirection >= 5,
        frameKeys,
      };
    }

    animations[name] = {
      id: animation.id,
      frameDelayMs: animation.frameDelayMs,
      directions,
    };
  }

  return {
    schemaVersion: 1,
    baseline: '0.9.143a',
    atlasKey: 'restaurant-avatar-placeholder',
    atlasJson: 'assets/generated/actors/restaurant-avatar-placeholder.json',
    physicalFrameCount: Object.keys(frames).length,
    sourceViewport: { width: 760, height: 600 },
    actorOriginViewport: { x: 380, y: 300 },
    tileHeightHalfPx: 20,
    animations,
    frames,
  };
}

describe('avatar atlas runtime descriptor', () => {
  it('constructs the recovered 98-frame physical set', () => {
    const parsed = parseAvatarAtlasRuntime(descriptor());
    expect(Object.keys(parsed.frames)).toHaveLength(98);
  });

  it('mirrors logical directions 5..7 onto recovered physical directions', () => {
    const parsed = parseAvatarAtlasRuntime(descriptor());

    expect(resolveAvatarAtlasFrame(parsed, 'walk', 5, 0)).toMatchObject({
      physicalDirection: 3,
      logicalDirection: 5,
      flipX: true,
      frameKey: 'avatar_service/walk/d3/f000',
    });
    expect(resolveAvatarAtlasFrame(parsed, 'walk', 7, 0)).toMatchObject({
      physicalDirection: 1,
      logicalDirection: 7,
      flipX: true,
      frameKey: 'avatar_service/walk/d1/f000',
    });
    expect(resolveAvatarAtlasFrame(parsed, 'walk', 4, 0)).toMatchObject({
      physicalDirection: 4,
      logicalDirection: 4,
      flipX: false,
    });
  });

  it('loops frame indexes within the recovered animation sequence', () => {
    const parsed = parseAvatarAtlasRuntime(descriptor());

    expect(resolveAvatarAtlasFrame(parsed, 'eat', 1, 0).frameKey).toBe(
      'avatar_service/eat/d1/f036',
    );
    expect(resolveAvatarAtlasFrame(parsed, 'eat', 1, 5).frameKey).toBe(
      'avatar_service/eat/d1/f037',
    );
  });

  it.each([
    'idle',
    'walk',
    'sit',
    'eat',
    'waitor-walk',
    'cooking',
    'waitor-working',
  ] as const)(
    'keeps every recovered %s logical direction backed by a physical frame',
    (animationName: Exclude<RecoveredAvatarAnimationName, 'hidden'>) => {
      const parsed = parseAvatarAtlasRuntime(descriptor());
      const animation = RECOVERED_AVATAR_ANIMATIONS[animationName];

      for (const direction of animation.directions) {
        const resolved = resolveAvatarAtlasFrame(
          parsed,
          animationName,
          direction,
          0,
        );
        expect(parsed.frames[resolved.frameKey]).toBeDefined();
      }
    },
  );

  it('fails closed on descriptor frame-count drift', () => {
    const broken = descriptor() as unknown as {
      physicalFrameCount: number;
    };
    broken.physicalFrameCount = 97;
    expect(() => parseAvatarAtlasRuntime(broken)).toThrow(
      /98 physical frames/,
    );
  });
});
