import { describe, expect, it } from 'vitest';
import {
  canonicalChefBaseCookDurationMs,
  canonicalCustomerSpawnDelayMs,
  canonicalMealGourmetPointTenths,
  canonicalServiceTimers,
  initialRestaurantServiceLoop,
  transitionRestaurantServiceLoop,
  type RestaurantServiceLoopState,
} from '../../src/game/serviceLoop';

function step(
  state: RestaurantServiceLoopState,
  event: Parameters<typeof transitionRestaurantServiceLoop>[1],
) {
  return transitionRestaurantServiceLoop(state, event);
}

describe('Restaurant City recovered service loop', () => {
  it('pins the recovered customer, chef and waiter timing constants', () => {
    expect(canonicalServiceTimers).toEqual({
      decisionAfterSittingMs: 1000,
      waitingForOrderMs: 10000,
      waitingForFoodMs: 120000,
      eatingMs: 25000,
      payingMs: 2000,
      chefCookMinMs: 16000,
      chefCookMaxMs: 32000,
      waiterActionMinMs: 2000,
      waiterActionMaxMs: 6000,
    });
  });

  it('matches the recovered chef work-time interpolation', () => {
    expect(canonicalChefBaseCookDurationMs(0)).toBe(32000);
    expect(canonicalChefBaseCookDurationMs(19.99)).toBe(32000);
    expect(canonicalChefBaseCookDurationMs(20)).toBe(32000);
    expect(canonicalChefBaseCookDurationMs(50)).toBe(24000);
    expect(canonicalChefBaseCookDurationMs(80)).toBe(16000);
    expect(canonicalChefBaseCookDurationMs(100)).toBe(16000);
  });

  it('matches customer admission cadence and the 550 demand cap', () => {
    expect(canonicalCustomerSpawnDelayMs(100, 0)).toBe(12000);
    expect(canonicalCustomerSpawnDelayMs(100, -3000)).toBe(9000);
    expect(canonicalCustomerSpawnDelayMs(600, 0)).toBeCloseTo(
      60000 / (550 * 0.05),
    );
    expect(() => canonicalCustomerSpawnDelayMs(0, 0)).toThrow();
    expect(() => canonicalCustomerSpawnDelayMs(100, 3000)).toThrow();
  });

  it('stores the recovered gourmet-point reward in canonical tenths', () => {
    expect(canonicalMealGourmetPointTenths(1)).toBe(10);
    expect(canonicalMealGourmetPointTenths(2)).toBe(12);
    expect(canonicalMealGourmetPointTenths(5)).toBe(18);
    expect(() => canonicalMealGourmetPointTenths(0)).toThrow();
  });

  it('replays the first happy-path service loop deterministically', () => {
    let state = initialRestaurantServiceLoop();

    ({ state } = step(state, { type: 'start-chair-walk' }));
    expect(state.customer).toBe('walking-to-chair');

    ({ state } = step(state, { type: 'reach-chair' }));
    expect(state).toMatchObject({
      customer: 'deciding',
      order: 'created',
      customerTimerMs: 1000,
    });

    ({ state } = step(state, { type: 'decision-elapsed' }));
    expect(state).toMatchObject({
      customer: 'waiting',
      order: 'queued',
      customerTimerMs: 10000,
    });

    ({ state } = step(state, {
      type: 'chef-assigned',
      cookDurationMs: 24000,
    }));
    expect(state).toMatchObject({
      customer: 'waiting-for-food',
      order: 'cooking',
      customerTimerMs: 120000,
      orderTimerMs: 24000,
    });

    ({ state } = step(state, { type: 'cook-elapsed' }));
    ({ state } = step(state, {
      type: 'waiter-collecting',
      actionDelayMs: 4000,
    }));
    ({ state } = step(state, { type: 'waiter-action-elapsed' }));
    ({ state } = step(state, { type: 'served' }));

    expect(state).toMatchObject({
      customer: 'eating',
      order: 'serving',
      customerTimerMs: 25000,
    });

    ({ state } = step(state, { type: 'eating-elapsed' }));
    expect(state).toMatchObject({
      customer: 'paying',
      order: 'empty-plate',
      customerTimerMs: 2000,
    });

    const cleared = step(state, { type: 'plate-cleared' });
    state = cleared.state;
    expect(cleared.effect).toEqual({ type: 'settle-meal' });
    expect(state).toMatchObject({
      customer: 'paying',
      order: 'settled',
    });

    const duplicateClear = step(state, { type: 'plate-cleared' });
    expect(duplicateClear.effect).toBeNull();
    expect(duplicateClear.state).toEqual(state);

    ({ state } = step(state, { type: 'paying-elapsed' }));
    ({ state } = step(state, { type: 'left' }));
    expect(state).toMatchObject({
      customer: 'left',
      order: 'settled',
    });
  });

  it('allows customer departure and plate settlement to complete independently', () => {
    let state = initialRestaurantServiceLoop();
    for (const event of [
      { type: 'start-chair-walk' } as const,
      { type: 'reach-chair' } as const,
      { type: 'decision-elapsed' } as const,
      { type: 'chef-assigned', cookDurationMs: 16000 } as const,
      { type: 'cook-elapsed' } as const,
      { type: 'waiter-collecting', actionDelayMs: 2000 } as const,
      { type: 'waiter-action-elapsed' } as const,
      { type: 'served' } as const,
      { type: 'eating-elapsed' } as const,
      { type: 'paying-elapsed' } as const,
      { type: 'left' } as const,
    ]) {
      ({ state } = step(state, event));
    }

    expect(state).toMatchObject({
      customer: 'left',
      order: 'empty-plate',
    });

    const settled = step(state, { type: 'plate-cleared' });
    expect(settled.effect).toEqual({ type: 'settle-meal' });
    expect(settled.state).toMatchObject({
      customer: 'left',
      order: 'settled',
    });
  });

  it('fails closed for impossible event order and tampered delays', () => {
    const initial = initialRestaurantServiceLoop();
    expect(() => step(initial, { type: 'plate-cleared' })).toThrow(
      /Invalid Restaurant City service-loop transition/,
    );

    let state = step(initial, { type: 'start-chair-walk' }).state;
    state = step(state, { type: 'reach-chair' }).state;
    state = step(state, { type: 'decision-elapsed' }).state;

    expect(() =>
      step(state, { type: 'chef-assigned', cookDurationMs: 15999 }),
    ).toThrow(/cookDurationMs/);
  });
});
