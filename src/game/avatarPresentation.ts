import type {
  AuthoritativeOrderServiceState,
  RestaurantActiveService,
} from '../net/restaurantAuthority';

export type RecoveredAvatarAnimationName =
  | 'idle'
  | 'walk'
  | 'sit'
  | 'eat'
  | 'waitor-walk'
  | 'cooking'
  | 'waitor-working'
  | 'hidden';

const ITEM_ROTATION_TO_ACTOR_DIRECTION = [1, 7, 5, 3] as const;

export function actorDirectionFromItemRotation(rotation: number): number {
  if (!Number.isInteger(rotation) || rotation < 0 || rotation > 3) {
    throw new Error('item rotation must be an integer in [0, 3]');
  }
  const direction = ITEM_ROTATION_TO_ACTOR_DIRECTION[rotation];
  if (direction === undefined) {
    throw new Error('recovered actor direction map is incomplete');
  }
  return direction;
}

export function chefDirectionFromKitchenRotation(rotation: number): number {
  return (actorDirectionFromItemRotation(rotation) + 4) % 8;
}

export const RECOVERED_WAITER_INITIAL_DIRECTION = 0 as const;

export interface RecoveredAvatarAnimationDefinition {
  readonly id: number;
  readonly frameStart: number;
  readonly frameEnd: number;
  readonly frameCount: number;
  readonly frameDelayMs: number;
  readonly directions: readonly number[];
}

export const RECOVERED_AVATAR_ANIMATIONS: Readonly<
  Record<Exclude<RecoveredAvatarAnimationName, 'hidden'>, RecoveredAvatarAnimationDefinition>
> = {
  idle: {
    id: 0,
    frameStart: 20,
    frameEnd: 23,
    frameCount: 4,
    frameDelayMs: 160,
    directions: [0, 1, 2, 3, 4, 5, 6, 7],
  },
  walk: {
    id: 1,
    frameStart: 0,
    frameEnd: 3,
    frameCount: 4,
    frameDelayMs: 140,
    directions: [0, 1, 2, 3, 4, 5, 6, 7],
  },
  sit: {
    id: 2,
    frameStart: 35,
    frameEnd: 35,
    frameCount: 1,
    frameDelayMs: 80,
    directions: [1, 3, 5, 7],
  },
  eat: {
    id: 3,
    frameStart: 36,
    frameEnd: 39,
    frameCount: 4,
    frameDelayMs: 80,
    directions: [1, 3, 5, 7],
  },
  'waitor-walk': {
    id: 4,
    frameStart: 10,
    frameEnd: 13,
    frameCount: 4,
    frameDelayMs: 160,
    directions: [0, 1, 2, 3, 4, 5, 6, 7],
  },
  cooking: {
    id: 5,
    frameStart: 30,
    frameEnd: 33,
    frameCount: 4,
    frameDelayMs: 80,
    directions: [1, 3, 5, 7],
  },
  'waitor-working': {
    id: 14,
    frameStart: 30,
    frameEnd: 33,
    frameCount: 4,
    frameDelayMs: 80,
    directions: [0, 1, 2, 3, 4, 5, 6, 7],
  },
};

export type ServiceActorAnchor =
  | 'chair'
  | 'kitchen'
  | 'waiter-tile'
  | 'hidden';

export interface ServiceActorPresentation {
  readonly animation: RecoveredAvatarAnimationName;
  readonly anchor: ServiceActorAnchor;
  readonly requiresAuthoritativePath: boolean;
}

export interface ActiveServiceActorPresentation {
  readonly serviceId: number;
  readonly customer: ServiceActorPresentation;
  readonly chef: ServiceActorPresentation;
  readonly waiter: ServiceActorPresentation;
}

function waiterAnimation(
  orderState: AuthoritativeOrderServiceState,
): ServiceActorPresentation {
  switch (orderState) {
    case 'created':
    case 'queued':
    case 'cooking':
      return {
        animation: 'idle',
        anchor: 'waiter-tile',
        requiresAuthoritativePath: false,
      };
    case 'completed':
      return {
        animation: 'walk',
        anchor: 'waiter-tile',
        requiresAuthoritativePath: true,
      };
    case 'waiter-collecting':
      return {
        animation: 'waitor-working',
        anchor: 'waiter-tile',
        requiresAuthoritativePath: false,
      };
    case 'serving':
      return {
        animation: 'waitor-walk',
        anchor: 'waiter-tile',
        requiresAuthoritativePath: true,
      };
    case 'empty-plate':
    case 'settled':
      return {
        animation: 'idle',
        anchor: 'waiter-tile',
        requiresAuthoritativePath: false,
      };
  }
}

export function activeServiceActorPresentation(
  active: RestaurantActiveService | null,
): ActiveServiceActorPresentation | null {
  if (active === null) return null;

  const customer: ServiceActorPresentation = (() => {
    switch (active.customerState) {
      case 'admitted':
        return {
          animation: 'idle',
          anchor: 'chair',
          requiresAuthoritativePath: false,
        };
      case 'walking-to-chair':
        return {
          animation: 'walk',
          anchor: 'chair',
          requiresAuthoritativePath: true,
        };
      case 'deciding':
      case 'waiting':
      case 'waiting-for-food':
      case 'paying':
        return {
          animation: 'sit',
          anchor: 'chair',
          requiresAuthoritativePath: false,
        };
      case 'eating':
        return {
          animation: 'eat',
          anchor: 'chair',
          requiresAuthoritativePath: false,
        };
      case 'leaving':
        return {
          animation: 'walk',
          anchor: 'chair',
          requiresAuthoritativePath: true,
        };
      case 'left':
        return {
          animation: 'hidden',
          anchor: 'hidden',
          requiresAuthoritativePath: false,
        };
    }
  })();

  const chef: ServiceActorPresentation =
    active.orderState === 'cooking'
      ? {
          animation: 'cooking',
          anchor: 'kitchen',
          requiresAuthoritativePath: false,
        }
      : {
          animation: 'idle',
          anchor: 'kitchen',
          requiresAuthoritativePath: false,
        };

  return {
    serviceId: active.serviceId,
    customer,
    chef,
    waiter: waiterAnimation(active.orderState),
  };
}
