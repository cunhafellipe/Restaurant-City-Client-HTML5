import contract from '../../contracts/restaurant-city/recovered-service-loop.json';

export type CustomerServiceState =
  | 'admitted'
  | 'walking-to-chair'
  | 'deciding'
  | 'waiting'
  | 'waiting-for-food'
  | 'eating'
  | 'paying'
  | 'leaving'
  | 'left';

export type OrderServiceState =
  | 'created'
  | 'queued'
  | 'cooking'
  | 'completed'
  | 'waiter-collecting'
  | 'serving'
  | 'empty-plate'
  | 'settled';

export interface RestaurantServiceLoopState {
  readonly customer: CustomerServiceState;
  readonly order: OrderServiceState;
  readonly customerTimerMs: number | null;
  readonly orderTimerMs: number | null;
}

export type RestaurantServiceLoopEvent =
  | { readonly type: 'start-chair-walk' }
  | { readonly type: 'reach-chair' }
  | { readonly type: 'decision-elapsed' }
  | { readonly type: 'chef-assigned'; readonly cookDurationMs: number }
  | { readonly type: 'cook-elapsed' }
  | { readonly type: 'waiter-collecting'; readonly actionDelayMs: number }
  | { readonly type: 'waiter-action-elapsed' }
  | { readonly type: 'served' }
  | { readonly type: 'eating-elapsed' }
  | { readonly type: 'paying-elapsed' }
  | { readonly type: 'plate-cleared' }
  | { readonly type: 'left' };

export type RestaurantServiceEffect =
  | { readonly type: 'settle-meal' }
  | null;

export interface RestaurantServiceTransition {
  readonly state: RestaurantServiceLoopState;
  readonly effect: RestaurantServiceEffect;
}

export const canonicalServiceTimers = Object.freeze({
  decisionAfterSittingMs: contract.customer.timersMs.decisionAfterSitting,
  waitingForOrderMs: contract.customer.timersMs.waitingForOrder,
  waitingForFoodMs: contract.customer.timersMs.waitingForFood,
  eatingMs: contract.customer.timersMs.eating,
  payingMs: contract.customer.timersMs.paying,
  chefCookMinMs: contract.chef.cookDurationMs.min,
  chefCookMaxMs: contract.chef.cookDurationMs.max,
  waiterActionMinMs: contract.waiter.actionDelayMs.min,
  waiterActionMaxMs: contract.waiter.actionDelayMs.max,
});

export function initialRestaurantServiceLoop(): RestaurantServiceLoopState {
  return {
    customer: 'admitted',
    order: 'created',
    customerTimerMs: null,
    orderTimerMs: null,
  };
}

export function canonicalCustomerSpawnDelayMs(
  demandPoints: number,
  jitterMs: number,
): number {
  requireFinitePositive(demandPoints, 'demandPoints');
  requireIntegerInRange(
    jitterMs,
    contract.admission.randomJitterMs.minInclusive,
    contract.admission.randomJitterMs.maxExclusive - 1,
    'jitterMs',
  );

  const boundedDemand = Math.min(demandPoints, contract.admission.maxDemand);
  return (
    60000 /
      (boundedDemand * contract.admission.customersPerMinutePerDemand) +
    jitterMs
  );
}

export function canonicalChefBaseCookDurationMs(workPercent: number): number {
  if (!Number.isFinite(workPercent) || workPercent < 0 || workPercent > 100) {
    throw new Error('workPercent must be between 0 and 100');
  }

  const min = canonicalServiceTimers.chefCookMinMs;
  const max = canonicalServiceTimers.chefCookMaxMs;

  if (workPercent >= 80) return min;
  if (workPercent < 20) return max;

  return max - ((max - min) * (workPercent - 20)) / 60;
}

export function canonicalMealGourmetPointTenths(recipeLevel: number): number {
  requireIntegerInRange(recipeLevel, 1, Number.MAX_SAFE_INTEGER, 'recipeLevel');
  const value = 10 + 2 * (recipeLevel - 1);
  if (!Number.isSafeInteger(value)) {
    throw new Error('recipeLevel reward overflow');
  }
  return value;
}

export function transitionRestaurantServiceLoop(
  current: RestaurantServiceLoopState,
  event: RestaurantServiceLoopEvent,
): RestaurantServiceTransition {
  switch (event.type) {
    case 'start-chair-walk':
      requirePair(current, 'admitted', 'created', event.type);
      return noEffect({
        ...current,
        customer: 'walking-to-chair',
      });

    case 'reach-chair':
      requirePair(current, 'walking-to-chair', 'created', event.type);
      return noEffect({
        ...current,
        customer: 'deciding',
        customerTimerMs: canonicalServiceTimers.decisionAfterSittingMs,
      });

    case 'decision-elapsed':
      requirePair(current, 'deciding', 'created', event.type);
      return noEffect({
        customer: 'waiting',
        order: 'queued',
        customerTimerMs: canonicalServiceTimers.waitingForOrderMs,
        orderTimerMs: null,
      });

    case 'chef-assigned':
      requirePair(current, 'waiting', 'queued', event.type);
      requireDurationInRange(
        event.cookDurationMs,
        canonicalServiceTimers.chefCookMinMs,
        canonicalServiceTimers.chefCookMaxMs,
        'cookDurationMs',
      );
      return noEffect({
        customer: 'waiting-for-food',
        order: 'cooking',
        customerTimerMs: canonicalServiceTimers.waitingForFoodMs,
        orderTimerMs: event.cookDurationMs,
      });

    case 'cook-elapsed':
      requirePair(current, 'waiting-for-food', 'cooking', event.type);
      return noEffect({
        ...current,
        order: 'completed',
        orderTimerMs: null,
      });

    case 'waiter-collecting':
      requirePair(current, 'waiting-for-food', 'completed', event.type);
      requireDurationInRange(
        event.actionDelayMs,
        canonicalServiceTimers.waiterActionMinMs,
        canonicalServiceTimers.waiterActionMaxMs,
        'actionDelayMs',
      );
      return noEffect({
        ...current,
        order: 'waiter-collecting',
        orderTimerMs: event.actionDelayMs,
      });

    case 'waiter-action-elapsed':
      requirePair(current, 'waiting-for-food', 'waiter-collecting', event.type);
      return noEffect({
        ...current,
        order: 'serving',
        orderTimerMs: null,
      });

    case 'served':
      requirePair(current, 'waiting-for-food', 'serving', event.type);
      return noEffect({
        customer: 'eating',
        order: 'serving',
        customerTimerMs: canonicalServiceTimers.eatingMs,
        orderTimerMs: null,
      });

    case 'eating-elapsed':
      requirePair(current, 'eating', 'serving', event.type);
      return noEffect({
        customer: 'paying',
        order: 'empty-plate',
        customerTimerMs: canonicalServiceTimers.payingMs,
        orderTimerMs: null,
      });

    case 'paying-elapsed':
      if (current.customer !== 'paying') {
        throw invalidTransition(current, event.type);
      }
      return noEffect({
        ...current,
        customer: 'leaving',
        customerTimerMs: null,
      });

    case 'plate-cleared':
      if (current.order === 'settled') {
        return noEffect(current);
      }
      if (current.order !== 'empty-plate') {
        throw invalidTransition(current, event.type);
      }
      return {
        state: {
          ...current,
          order: 'settled',
          orderTimerMs: null,
        },
        effect: { type: 'settle-meal' },
      };

    case 'left':
      if (current.customer !== 'leaving') {
        throw invalidTransition(current, event.type);
      }
      return noEffect({
        ...current,
        customer: 'left',
        customerTimerMs: null,
      });
  }
}

function noEffect(
  state: RestaurantServiceLoopState,
): RestaurantServiceTransition {
  return { state, effect: null };
}

function requirePair(
  state: RestaurantServiceLoopState,
  customer: CustomerServiceState,
  order: OrderServiceState,
  event: RestaurantServiceLoopEvent['type'],
): void {
  if (state.customer !== customer || state.order !== order) {
    throw invalidTransition(state, event);
  }
}

function requireDurationInRange(
  value: number,
  min: number,
  max: number,
  field: string,
): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} must be between ${min} and ${max} ms`);
  }
}

function requireFinitePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be finite and positive`);
  }
}

function requireIntegerInRange(
  value: number,
  min: number,
  max: number,
  field: string,
): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${field} out of range`);
  }
}

function invalidTransition(
  state: RestaurantServiceLoopState,
  event: RestaurantServiceLoopEvent['type'],
): Error {
  return new Error(
    `Invalid Restaurant City service-loop transition: ${state.customer}/${state.order} + ${event}`,
  );
}
