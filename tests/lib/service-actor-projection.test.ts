import { describe, expect, it } from 'vitest';
import {
  projectActiveServiceActors,
} from '../../src/game/serviceActorProjection';
import type {
  RestaurantActiveService,
  RestaurantServiceTopology,
} from '../../src/net/restaurantAuthority';

const activeBase: RestaurantActiveService = {
  serviceId: 1,
  restaurantMutationSequence: 9,
  customerId: 1,
  orderId: 1,
  chairInstanceId: 11,
  tableInstanceId: 12,
  chefEmployeeId: 101,
  kitchenInstanceId: 13,
  waiterEmployeeId: 201,
  waiterTileX: 5,
  waiterTileY: 4,
  customerState: 'waiting-for-food',
  orderState: 'cooking',
  customerTimerMs: 1000,
  orderTimerMs: 1000,
};

const topology: RestaurantServiceTopology = {
  source: {
    room: { insideX: 8, insideY: 8, outsideX: 0, outsideY: 0 },
    items: [
      {
        instanceId: 11,
        itemId: 3040000,
        tileX: 3,
        tileY: 3,
        rotation: 1,
        roomIndex: 0,
      },
      {
        instanceId: 12,
        itemId: 3030000,
        tileX: 3,
        tileY: 4,
        rotation: 0,
        roomIndex: 0,
      },
      {
        instanceId: 13,
        itemId: 3070000,
        tileX: 5,
        tileY: 5,
        rotation: 3,
        roomIndex: 0,
      },
    ],
  },
  cells: [],
  chairs: [
    {
      instanceId: 11,
      tileX: 3,
      tileY: 3,
      rotation: 1,
      toilet: false,
      mealSeat: true,
      facingTileX: 3,
      facingTileY: 4,
      tableInstanceId: 12,
    },
  ],
  tables: [
    {
      instanceId: 12,
      tileX: 3,
      tileY: 4,
      itemCountOnTile: 1,
      hasTableTopOrder: true,
      free: false,
    },
  ],
  kitchens: [{ instanceId: 13, tileX: 5, tileY: 5 }],
  drinks: [],
};

describe('authoritative service actor projection', () => {
  it('projects seated customer, chef facing tile and idle waiter from authority', () => {
    expect(projectActiveServiceActors(activeBase, topology)).toEqual([
      {
        role: 'customer',
        animation: 'sit',
        tile: { x: 3, y: 3 },
        direction: 7,
      },
      {
        role: 'chef',
        animation: 'cooking',
        tile: { x: 5, y: 4 },
        direction: 7,
      },
      {
        role: 'waiter',
        animation: 'idle',
        tile: { x: 5, y: 4 },
        direction: 0,
      },
    ]);
  });

  it('does not confuse the chair-facing table tile with the seated customer tile', () => {
    const customer = projectActiveServiceActors(activeBase, topology).find(
      (actor) => actor.role === 'customer',
    );
    expect(customer?.tile).toEqual({ x: 3, y: 3 });
    expect(topology.chairs[0]?.facingTileX).toBe(3);
    expect(topology.chairs[0]?.facingTileY).toBe(4);
    expect(customer?.tile).not.toEqual({
      x: topology.chairs[0]?.facingTileX,
      y: topology.chairs[0]?.facingTileY,
    });
  });

  it('keeps path-dependent customer and waiter actors hidden', () => {
    const actors = projectActiveServiceActors(
      {
        ...activeBase,
        customerState: 'walking-to-chair',
        orderState: 'serving',
      },
      topology,
    );
    expect(actors.map((actor) => actor.role)).toEqual(['chef']);
  });

  it('keeps admitted customer hidden until entrance path is authoritative', () => {
    const actors = projectActiveServiceActors(
      { ...activeBase, customerState: 'admitted' },
      topology,
    );
    expect(actors.some((actor) => actor.role === 'customer')).toBe(false);
  });

  it('faces waiter toward the stove during the recovered collecting action', () => {
    const waiter = projectActiveServiceActors(
      { ...activeBase, orderState: 'waiter-collecting' },
      topology,
    ).find((actor) => actor.role === 'waiter');
    expect(waiter).toEqual({
      role: 'waiter',
      animation: 'waitor-working',
      tile: { x: 5, y: 4 },
      direction: 7,
    });
  });

  it('fails closed when an active service references missing topology', () => {
    expect(() =>
      projectActiveServiceActors(activeBase, {
        ...topology,
        chairs: [],
      }),
    ).toThrow(/missing chair instance/);
    expect(() => projectActiveServiceActors(activeBase, null)).toThrow(
      /cannot render without authoritative topology/,
    );
  });

  it('returns no actors without an active service', () => {
    expect(projectActiveServiceActors(null, topology)).toEqual([]);
  });
});
