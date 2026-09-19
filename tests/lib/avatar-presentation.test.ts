import { describe, expect, it } from 'vitest';
import recoveredContract from '../../contracts/restaurant-city/recovered-avatar-service-presentation.json';
import {
  RECOVERED_AVATAR_ANIMATIONS,
  RECOVERED_WAITER_INITIAL_DIRECTION,
  activeServiceActorPresentation,
  actorDirectionFromItemRotation,
  chefDirectionFromKitchenRotation,
} from '../../src/game/avatarPresentation';
import type {
  AuthoritativeCustomerServiceState,
  AuthoritativeOrderServiceState,
  RestaurantActiveService,
} from '../../src/net/restaurantAuthority';

function active(
  customerState: AuthoritativeCustomerServiceState,
  orderState: AuthoritativeOrderServiceState,
): RestaurantActiveService {
  return {
    serviceId: 7,
    restaurantMutationSequence: 3,
    customerId: 7,
    orderId: 7,
    chairInstanceId: 11,
    tableInstanceId: 12,
    chefEmployeeId: 101,
    kitchenInstanceId: 13,
    waiterEmployeeId: 201,
    waiterTileX: 4,
    waiterTileY: 4,
    customerState,
    orderState,
    customerTimerMs: null,
    orderTimerMs: null,
  };
}

describe('recovered avatar presentation contract', () => {
  it('keeps the historical item-rotation to actor-direction map', () => {
    expect([0, 1, 2, 3].map(actorDirectionFromItemRotation)).toEqual([
      1, 7, 5, 3,
    ]);
    expect([0, 1, 2, 3].map(chefDirectionFromKitchenRotation)).toEqual([
      5, 3, 1, 7,
    ]);
    expect(RECOVERED_WAITER_INITIAL_DIRECTION).toBe(0);
    expect(() => actorDirectionFromItemRotation(4)).toThrow(/\[0, 3\]/);
  });

  it('keeps TypeScript animation metadata pinned to the recovered contract', () => {
    const byName = new Map(
      recoveredContract.animation.definitions.map((definition) => [
        definition.name,
        definition,
      ]),
    );

    for (const [name, animation] of Object.entries(
      RECOVERED_AVATAR_ANIMATIONS,
    )) {
      const recovered = byName.get(name);
      expect(recovered, name).toBeDefined();
      expect(animation).toEqual({
        id: recovered!.id,
        frameStart: recovered!.frameStart,
        frameEnd: recovered!.frameEnd,
        frameCount: recovered!.frameCount,
        frameDelayMs: recovered!.frameDelayMs,
        directions: recovered!.directions,
      });
    }
  });

  it.each([
    ['admitted', 'hidden', true],
    ['walking-to-chair', 'walk', true],
    ['deciding', 'sit', false],
    ['waiting', 'sit', false],
    ['waiting-for-food', 'sit', false],
    ['eating', 'eat', false],
    ['paying', 'sit', false],
    ['leaving', 'walk', true],
    ['left', 'hidden', false],
  ] as const)(
    'maps customer %s to %s without inventing path state',
    (customerState, animation, requiresAuthoritativePath) => {
      const presentation = activeServiceActorPresentation(
        active(customerState, 'created'),
      );
      expect(presentation?.customer).toMatchObject({
        animation,
        requiresAuthoritativePath,
      });
    },
  );

  it.each([
    ['created', 'idle', 'waiter-tile', false],
    ['queued', 'idle', 'waiter-tile', false],
    ['cooking', 'idle', 'waiter-tile', false],
    ['completed', 'walk', 'waiter-tile', true],
    ['waiter-collecting', 'waitor-working', 'waiter-tile', false],
    ['serving', 'waitor-walk', 'waiter-tile', true],
    ['empty-plate', 'hidden', 'hidden', true],
    ['settled', 'hidden', 'hidden', true],
  ] as const)(
    'maps waiter order state %s to %s',
    (orderState, animation, anchor, requiresAuthoritativePath) => {
      const presentation = activeServiceActorPresentation(
        active('waiting-for-food', orderState),
      );
      expect(presentation?.waiter).toEqual({
        animation,
        anchor,
        requiresAuthoritativePath,
      });
    },
  );

  it('uses cooking only while the authoritative order is cooking', () => {
    expect(
      activeServiceActorPresentation(active('waiting-for-food', 'cooking'))
        ?.chef,
    ).toEqual({
      animation: 'cooking',
      anchor: 'kitchen',
      requiresAuthoritativePath: false,
    });

    expect(
      activeServiceActorPresentation(active('waiting-for-food', 'completed'))
        ?.chef.animation,
    ).toBe('idle');
  });

  it('has no presentation without an authoritative active service', () => {
    expect(activeServiceActorPresentation(null)).toBeNull();
  });
});
