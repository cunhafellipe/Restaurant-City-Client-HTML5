import type {
  AuthoritativePlacedItem,
  AuthoritativeServiceChair,
  RestaurantActiveService,
  RestaurantServiceTopology,
} from '../net/restaurantAuthority';
import {
  RECOVERED_WAITER_INITIAL_DIRECTION,
  activeServiceActorPresentation,
  actorDirectionFromItemRotation,
  chefDirectionFromKitchenRotation,
  type RecoveredAvatarAnimationName,
} from './avatarPresentation';

export type ServiceActorRole = 'customer' | 'chef' | 'waiter';

export interface ProjectedServiceActor {
  readonly role: ServiceActorRole;
  readonly animation: Exclude<RecoveredAvatarAnimationName, 'hidden'>;
  readonly tile: { readonly x: number; readonly y: number };
  readonly direction: number;
}

function facingTile(
  tileX: number,
  tileY: number,
  rotation: number,
): { readonly x: number; readonly y: number } {
  switch (rotation) {
    case 0:
      return { x: tileX + 1, y: tileY };
    case 1:
      return { x: tileX, y: tileY + 1 };
    case 2:
      return { x: tileX - 1, y: tileY };
    case 3:
      return { x: tileX, y: tileY - 1 };
    default:
      throw new Error('service actor facing rotation must be in [0, 3]');
  }
}

function sourceItem(
  topology: RestaurantServiceTopology,
  instanceId: number,
  label: string,
): AuthoritativePlacedItem {
  const item = topology.source.items.find(
    (candidate) => candidate.instanceId === instanceId,
  );
  if (!item) {
    throw new Error(
      `authoritative service topology is missing ${label} instance #${instanceId}`,
    );
  }
  if (item.rotation < 0 || item.rotation > 3) {
    throw new Error(
      `authoritative ${label} #${instanceId} has unsupported actor-facing rotation ${item.rotation}`,
    );
  }
  return item;
}

function serviceChair(
  topology: RestaurantServiceTopology,
  instanceId: number,
): AuthoritativeServiceChair {
  const chair = topology.chairs.find(
    (candidate) => candidate.instanceId === instanceId,
  );
  if (!chair) {
    throw new Error(
      `authoritative service topology is missing chair instance #${instanceId}`,
    );
  }
  return chair;
}

export function projectActiveServiceActors(
  active: RestaurantActiveService | null,
  topology: RestaurantServiceTopology | null,
): readonly ProjectedServiceActor[] {
  if (active === null) return [];
  if (topology === null) {
    throw new Error('active service cannot render without authoritative topology');
  }

  const presentation = activeServiceActorPresentation(active);
  if (!presentation) return [];

  const actors: ProjectedServiceActor[] = [];
  const chair = serviceChair(topology, active.chairInstanceId);
  const kitchen = sourceItem(topology, active.kitchenInstanceId, 'kitchen');
  const kitchenFacing = facingTile(
    kitchen.tileX,
    kitchen.tileY,
    kitchen.rotation,
  );

  if (
    presentation.customer.animation !== 'hidden' &&
    !presentation.customer.requiresAuthoritativePath
  ) {
    actors.push({
      role: 'customer',
      animation: presentation.customer.animation,
      tile: { x: chair.facingTileX, y: chair.facingTileY },
      direction: actorDirectionFromItemRotation(chair.rotation),
    });
  }

  if (
    presentation.chef.animation !== 'hidden' &&
    !presentation.chef.requiresAuthoritativePath
  ) {
    actors.push({
      role: 'chef',
      animation: presentation.chef.animation,
      tile: kitchenFacing,
      direction: chefDirectionFromKitchenRotation(kitchen.rotation),
    });
  }

  if (
    presentation.waiter.animation !== 'hidden' &&
    !presentation.waiter.requiresAuthoritativePath
  ) {
    const working = presentation.waiter.animation === 'waitor-working';
    actors.push({
      role: 'waiter',
      animation: presentation.waiter.animation,
      tile: { x: active.waiterTileX, y: active.waiterTileY },
      // Waitor's CachedAvatar3D direction starts at 0. At the recovered
      // kitchen action it explicitly face()s the kitchen; when the server
      // reports waiter-collecting we can use the same facing orientation as
      // a chef on that stove. Moving states remain fail-closed above.
      direction: working
        ? chefDirectionFromKitchenRotation(kitchen.rotation)
        : RECOVERED_WAITER_INITIAL_DIRECTION,
    });
  }

  return actors;
}
