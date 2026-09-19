import type Phaser from 'phaser';
import type { RestaurantAuthority } from '../net/restaurantAuthority';

export const RESTAURANT_AUTHORITY_REGISTRY_KEY =
  'anewon.restaurant-city.authority';

export function installRestaurantAuthority(
  game: Phaser.Game,
  authority: RestaurantAuthority,
): void {
  game.registry.set(RESTAURANT_AUTHORITY_REGISTRY_KEY, authority);
}

export function requireRestaurantAuthority(
  scene: Phaser.Scene,
): RestaurantAuthority {
  const candidate: unknown = scene.registry.get(
    RESTAURANT_AUTHORITY_REGISTRY_KEY,
  );

  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    !('loadRestaurant' in candidate) ||
    typeof candidate.loadRestaurant !== 'function' ||
    !('placeItem' in candidate) ||
    typeof candidate.placeItem !== 'function' ||
    !('paintFloorTile' in candidate) ||
    typeof candidate.paintFloorTile !== 'function' ||
    !('transformItem' in candidate) ||
    typeof candidate.transformItem !== 'function' ||
    !('removeItem' in candidate) ||
    typeof candidate.removeItem !== 'function'
  ) {
    throw new Error(
      'Restaurant City authoritative service is not installed in the Phaser registry',
    );
  }

  return candidate as RestaurantAuthority;
}
