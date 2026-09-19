import { describe, expect, it, vi } from 'vitest';
import {
  HttpRestaurantAuthority,
  RestaurantAuthorityError,
  createFloorTileMutationId,
  createPlacementMutationId,
  createRemoveMutationId,
  createTransformMutationId,
  createWallpaperMutationId,
} from '../../src/net/restaurantAuthority';

function okJson(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('HttpRestaurantAuthority', () => {
  it('invokes the default browser fetch with globalThis as its receiver', async () => {
    const originalFetch = globalThis.fetch;
    const receiverFetch = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(
        okJson({
          room: {
            inside_x: 8,
            inside_y: 8,
            outside_x: 0,
            outside_y: 0,
          },
          next_instance_id: 1,
          items: [],
          floor_tiles: [],

          wallpapers: [],
          inventory: [],
        }),
      );
    });

    Object.defineProperty(globalThis, 'fetch', {
      value: receiverFetch,
      configurable: true,
      writable: true,
    });

    try {
      const authority = new HttpRestaurantAuthority();
      await expect(authority.loadRestaurant()).resolves.toMatchObject({
        nextInstanceId: 1,
        items: [],
      });
      expect(receiverFetch).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        value: originalFetch,
        configurable: true,
        writable: true,
      });
    }
  });

  it('loads authoritative state with same-origin cookies and no bearer token', async () => {
    const fetcher = vi.fn(async () =>
      okJson({
        room: {
          inside_x: 8,
          inside_y: 8,
          outside_x: 0,
          outside_y: 0,
        },
        next_instance_id: 2,
        items: [
          {
            instance_id: 1,
            item_id: 10,
            tile_x: 2,
            tile_y: 3,
            rotation: 1,
            room_index: 0,
          },
        ],
        floor_tiles: [],

        wallpapers: [],
        inventory: [
          {
            item_id: 10,
            owned: 2,
            placed: 1,
            available: 1,
          },
        ],
      }),
    );

    const authority = new HttpRestaurantAuthority('/api/v1', fetcher);
    const layout = await authority.loadRestaurant();

    expect(layout.items[0]?.instanceId).toBe(1);
    expect(layout.inventory[0]).toEqual({
      itemId: 10,
      owned: 2,
      placed: 1,
      available: 1,
    });
    expect(layout.room.insideX).toBe(8);

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('/api/v1/restaurant');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.cache).toBe('no-store');
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
  });

  it('loads read-only service topology and retries a stale source snapshot', async () => {
    const room = {
      inside_x: 8,
      inside_y: 8,
      outside_x: 0,
      outside_y: 0,
    };
    const placed = {
      instance_id: 1,
      item_id: 3070008,
      tile_x: 4,
      tile_y: 4,
      rotation: 2,
      room_index: 0,
    };
    const layout = {
      room,
      next_instance_id: 2,
      items: [placed],
      floor_tiles: [],
      wallpapers: [],
      inventory: [
        {
          item_id: 3070008,
          owned: 1,
          placed: 1,
          available: 0,
        },
      ],
    };
    const topology = {
      source: { room, items: [placed] },
      cells: [
        {
          tile_x: 4,
          tile_y: 4,
          wall: false,
          item_count: 1,
          has_door: false,
          walkable: false,
        },
        {
          tile_x: 3,
          tile_y: 4,
          wall: false,
          item_count: 1,
          has_door: false,
          walkable: false,
        },
      ],
      chairs: [],
      tables: [],
      kitchens: [{ instance_id: 1, tile_x: 4, tile_y: 4 }],
      drinks: [],
    };
    const staleTopology = {
      ...topology,
      source: {
        room,
        items: [{ ...placed, tile_x: 5 }],
      },
    };

    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(okJson(layout))
      .mockResolvedValueOnce(okJson(staleTopology))
      .mockResolvedValueOnce(okJson(layout))
      .mockResolvedValueOnce(okJson(topology))
      .mockResolvedValueOnce(okJson({ active: null }));

    const authority = new HttpRestaurantAuthority('/api/v1', fetcher);
    const snapshot = await authority.loadRestaurantSnapshot();

    expect(snapshot.layout.items[0]?.tileX).toBe(4);
    expect(snapshot.topology.kitchens[0]).toEqual({
      instanceId: 1,
      tileX: 4,
      tileY: 4,
    });
    expect(snapshot.topology.cells).toHaveLength(2);
    expect(snapshot.activeService).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(fetcher.mock.calls[1]?.[0]).toBe('/api/v1/restaurant/topology');
    expect(fetcher.mock.calls[1]?.[1]?.credentials).toBe('same-origin');
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).has('Authorization')).toBe(false);
    expect(fetcher.mock.calls[4]?.[0]).toBe('/api/v1/restaurant/service');
    expect(fetcher.mock.calls[4]?.[1]?.credentials).toBe('same-origin');
  });

  it('loads and validates the read-only active service projection', async () => {
    const fetcher = vi.fn(async () =>
      okJson({
        active: {
          service_id: 7,
          restaurant_mutation_sequence: 3,
          customer_id: 7,
          order_id: 7,
          chair_instance_id: 11,
          table_instance_id: 12,
          chef_employee_id: 101,
          kitchen_instance_id: 13,
          waiter_employee_id: 201,
          waiter_tile_x: 4,
          waiter_tile_y: 4,
          customer_state: 'waiting-for-food',
          order_state: 'cooking',
          customer_timer_ms: 120000,
          order_timer_ms: 24000,
        },
      }),
    );
    const authority = new HttpRestaurantAuthority('/api/v1', fetcher);

    await expect(authority.loadActiveService()).resolves.toEqual({
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
      customerState: 'waiting-for-food',
      orderState: 'cooking',
      customerTimerMs: 120000,
      orderTimerMs: 24000,
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/v1/restaurant/service');
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(fetcher.mock.calls[0]?.[1]?.cache).toBe('no-store');
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).has('Authorization'),
    ).toBe(false);
  });

  it('rejects malformed active-service identity and state', async () => {
    const invalidIdentity = new HttpRestaurantAuthority(
      '/api/v1',
      async () =>
        okJson({
          active: {
            service_id: 1,
            restaurant_mutation_sequence: 3,
            customer_id: 2,
            order_id: 1,
            chair_instance_id: 11,
            table_instance_id: 12,
            chef_employee_id: 101,
            kitchen_instance_id: 13,
            waiter_employee_id: 201,
            waiter_tile_x: 4,
            waiter_tile_y: 4,
            customer_state: 'admitted',
            order_state: 'created',
            customer_timer_ms: null,
            order_timer_ms: null,
          },
        }),
    );
    await expect(invalidIdentity.loadActiveService()).rejects.toThrow(
      'active service identity',
    );

    const invalidState = new HttpRestaurantAuthority(
      '/api/v1',
      async () =>
        okJson({
          active: {
            service_id: 1,
            restaurant_mutation_sequence: 3,
            customer_id: 1,
            order_id: 1,
            chair_instance_id: 11,
            table_instance_id: 12,
            chef_employee_id: 101,
            kitchen_instance_id: 13,
            waiter_employee_id: 201,
            waiter_tile_x: 4,
            waiter_tile_y: 4,
            customer_state: 'teleporting',
            order_state: 'created',
            customer_timer_ms: null,
            order_timer_ms: null,
          },
        }),
    );
    await expect(invalidState.loadActiveService()).rejects.toThrow(
      'active service state',
    );
  });

  it('loads floor cells and counts them in the authoritative inventory invariant', async () => {
    const authority = new HttpRestaurantAuthority(
      '/api/v1',
      async () =>
        okJson({
          room: { inside_x: 8, inside_y: 8, outside_x: 0, outside_y: 0 },
          next_instance_id: 1,
          items: [],
          floor_tiles: [
            { item_id: 3050000, tile_x: 2, tile_y: 3, room_index: 0 },
          ],

          wallpapers: [],
          inventory: [
            { item_id: 3050000, owned: 1, placed: 1, available: 0 },
          ],
        }),
    );

    const layout = await authority.loadRestaurant();
    expect(layout.floorTiles).toEqual([
      { itemId: 3050000, tileX: 2, tileY: 3, roomIndex: 0 },
    ]);
  });

  it('loads wallpaper slots and counts them in authoritative inventory', async () => {
    const authority = new HttpRestaurantAuthority(
      '/api/v1',
      async () =>
        okJson({
          room: { inside_x: 8, inside_y: 8, outside_x: 0, outside_y: 0 },
          next_instance_id: 1,
          items: [],
          floor_tiles: [],
          wallpapers: [
            { item_id: 3060000, rotation: 0 },
            { item_id: 3060001, rotation: 1 },
          ],
          inventory: [
            { item_id: 3060000, owned: 1, placed: 1, available: 0 },
            { item_id: 3060001, owned: 1, placed: 1, available: 0 },
          ],
        }),
    );

    const layout = await authority.loadRestaurant();
    expect(layout.wallpapers).toEqual([
      { itemId: 3060000, rotation: 0 },
      { itemId: 3060001, rotation: 1 },
    ]);
  });

  it('puts and deletes wallpaper slots with same-origin idempotency', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        okJson({
          outcome: 'applied',
          wallpaper: { item_id: 3060000, rotation: 0 },
        }),
      )
      .mockResolvedValueOnce(
        okJson({
          outcome: 'applied',
          wallpaper: { item_id: 3060000, rotation: 0 },
        }),
      );

    const authority = new HttpRestaurantAuthority('/api/v1', fetcher);
    const applied = await authority.applyWallpaper(
      { itemId: 3060000, tileX: 0, tileY: 3 },
      'rc-wallpaper-apply-1',
    );
    expect(applied.wallpaper).toEqual({ itemId: 3060000, rotation: 0 });

    const [applyUrl, applyInit] = fetcher.mock.calls[0]!;
    expect(applyUrl).toBe('/api/v1/restaurant/wallpapers');
    expect(applyInit?.method).toBe('PUT');
    expect(applyInit?.credentials).toBe('same-origin');
    expect(new Headers(applyInit?.headers).get('Idempotency-Key')).toBe(
      'rc-wallpaper-apply-1',
    );
    expect(JSON.parse(String(applyInit?.body))).toEqual({
      item_id: 3060000,
      tile_x: 0,
      tile_y: 3,
    });

    const removed = await authority.removeWallpaper(
      0,
      'rc-wallpaper-remove-1',
    );
    expect(removed.wallpaper).toEqual({ itemId: 3060000, rotation: 0 });

    const [removeUrl, removeInit] = fetcher.mock.calls[1]!;
    expect(removeUrl).toBe('/api/v1/restaurant/wallpapers/0');
    expect(removeInit?.method).toBe('DELETE');
    expect(removeInit?.credentials).toBe('same-origin');
    expect(new Headers(removeInit?.headers).get('Idempotency-Key')).toBe(
      'rc-wallpaper-remove-1',
    );
    expect(removeInit?.body).toBeUndefined();
  });

  it('rejects malformed or duplicate wallpaper orientations locally', async () => {
    const invalidRotation = new HttpRestaurantAuthority(
      '/api/v1',
      async () =>
        okJson({
          room: { inside_x: 8, inside_y: 8, outside_x: 0, outside_y: 0 },
          next_instance_id: 1,
          items: [],
          floor_tiles: [],
          wallpapers: [{ item_id: 3060000, rotation: 2 }],
          inventory: [
            { item_id: 3060000, owned: 1, placed: 1, available: 0 },
          ],
        }),
    );
    await expect(invalidRotation.loadRestaurant()).rejects.toThrow(
      'wallpaper rotation',
    );

    const duplicateOrientation = new HttpRestaurantAuthority(
      '/api/v1',
      async () =>
        okJson({
          room: { inside_x: 8, inside_y: 8, outside_x: 0, outside_y: 0 },
          next_instance_id: 1,
          items: [],
          floor_tiles: [],
          wallpapers: [
            { item_id: 3060000, rotation: 1 },
            { item_id: 3060001, rotation: 1 },
          ],
          inventory: [
            { item_id: 3060000, owned: 1, placed: 1, available: 0 },
            { item_id: 3060001, owned: 1, placed: 1, available: 0 },
          ],
        }),
    );
    await expect(duplicateOrientation.loadRestaurant()).rejects.toThrow(
      'duplicate wallpaper orientation',
    );
  });

  it('puts strict floor-tile DTO with same-origin idempotency', async () => {
    const fetcher = vi.fn(async () =>
      okJson({
        outcome: 'applied',
        tile: {
          item_id: 3050000,
          tile_x: 2,
          tile_y: 3,
          room_index: 0,
        },
      }),
    );
    const authority = new HttpRestaurantAuthority('/api/v1', fetcher);
    const commit = await authority.paintFloorTile(
      { itemId: 3050000, tileX: 2, tileY: 3 },
      'rc-floor-test-1',
    );

    expect(commit.tile).toEqual({
      itemId: 3050000,
      tileX: 2,
      tileY: 3,
      roomIndex: 0,
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('/api/v1/restaurant/floor-tiles');
    expect(init?.method).toBe('PUT');
    expect(init?.credentials).toBe('same-origin');
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(
      'rc-floor-test-1',
    );
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({
      item_id: 3050000,
      tile_x: 2,
      tile_y: 3,
    });
  });

  it('posts strict placement DTO with a stable idempotency key', async () => {
    const fetcher = vi.fn(async () =>
      okJson({
        outcome: 'applied',
        item: {
          instance_id: 7,
          item_id: 10,
          tile_x: 2,
          tile_y: 3,
          rotation: 2,
          room_index: 0,
        },
      }),
    );

    const authority = new HttpRestaurantAuthority('/api/v1', fetcher);
    const commit = await authority.placeItem(
      { itemId: 10, tileX: 2, tileY: 3, rotation: 2 },
      'rc-placement-test-1',
    );

    expect(commit.outcome).toBe('applied');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('/api/v1/restaurant/placements');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');

    const headers = new Headers(init?.headers);
    expect(headers.get('Idempotency-Key')).toBe('rc-placement-test-1');
    expect(headers.has('Authorization')).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({
      item_id: 10,
      tile_x: 2,
      tile_y: 3,
      rotation: 2,
    });
  });

  it('patches and deletes existing instances with same-origin idempotent mutations', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        okJson({
          outcome: 'applied',
          item: {
            instance_id: 7,
            item_id: 10,
            tile_x: 4,
            tile_y: 3,
            rotation: 1,
            room_index: 0,
          },
        }),
      )
      .mockResolvedValueOnce(
        okJson({
          outcome: 'applied',
          item: {
            instance_id: 7,
            item_id: 10,
            tile_x: 4,
            tile_y: 3,
            rotation: 1,
            room_index: 0,
          },
        }),
      );

    const authority = new HttpRestaurantAuthority('/api/v1', fetcher);

    const transformed = await authority.transformItem(
      7,
      { tileX: 4, tileY: 3, rotation: 1 },
      'rc-transform-test-1',
    );
    expect(transformed.item.instanceId).toBe(7);

    const [transformUrl, transformInit] = fetcher.mock.calls[0]!;
    expect(transformUrl).toBe('/api/v1/restaurant/placements/7');
    expect(transformInit?.method).toBe('PATCH');
    expect(transformInit?.credentials).toBe('same-origin');
    expect(new Headers(transformInit?.headers).get('Idempotency-Key')).toBe(
      'rc-transform-test-1',
    );
    expect(new Headers(transformInit?.headers).has('Authorization')).toBe(false);
    expect(JSON.parse(String(transformInit?.body))).toEqual({
      tile_x: 4,
      tile_y: 3,
      rotation: 1,
    });

    const removed = await authority.removeItem(7, 'rc-remove-test-1');
    expect(removed.item.instanceId).toBe(7);

    const [removeUrl, removeInit] = fetcher.mock.calls[1]!;
    expect(removeUrl).toBe('/api/v1/restaurant/placements/7');
    expect(removeInit?.method).toBe('DELETE');
    expect(removeInit?.credentials).toBe('same-origin');
    expect(new Headers(removeInit?.headers).get('Idempotency-Key')).toBe(
      'rc-remove-test-1',
    );
    expect(new Headers(removeInit?.headers).has('Authorization')).toBe(false);
    expect(removeInit?.body).toBeUndefined();
  });

  it('rejects invalid instance ids and transform payloads locally', async () => {
    const fetcher = vi.fn(async () => okJson({}));
    const authority = new HttpRestaurantAuthority('/api/v1', fetcher);

    await expect(
      authority.transformItem(
        0,
        { tileX: 2, tileY: 2, rotation: 0 },
        'rc-transform-invalid',
      ),
    ).rejects.toThrow('Invalid Restaurant City instance id');

    await expect(
      authority.transformItem(
        1,
        { tileX: 2, tileY: 2, rotation: 16 },
        'rc-transform-invalid-rotation',
      ),
    ).rejects.toThrow('Invalid Restaurant City transform command');

    await expect(
      authority.removeItem(0, 'rc-remove-invalid'),
    ).rejects.toThrow('Invalid Restaurant City instance id');

    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps transport compatible with recovered 16-frame RoomItems', async () => {
    const fetcher = vi.fn(async () =>
      okJson({
        outcome: 'applied',
        item: {
          instance_id: 7,
          item_id: 10,
          tile_x: 2,
          tile_y: 3,
          rotation: 15,
          room_index: 0,
        },
      }),
    );

    const authority = new HttpRestaurantAuthority('/api/v1', fetcher);
    const commit = await authority.placeItem(
      { itemId: 10, tileX: 2, tileY: 3, rotation: 15 },
      'rc-placement-rotation-15',
    );

    expect(commit.item.rotation).toBe(15);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).rotation).toBe(15);
  });

  it('fails closed on malformed topology cells', async () => {
    const authority = new HttpRestaurantAuthority(
      '/api/v1',
      async () =>
        okJson({
          source: {
            room: { inside_x: 8, inside_y: 8, outside_x: 0, outside_y: 0 },
            items: [],
          },
          cells: [
            {
              tile_x: 1,
              tile_y: 1,
              wall: false,
              item_count: 0,
              has_door: false,
              walkable: true,
            },
            {
              tile_x: 1,
              tile_y: 1,
              wall: false,
              item_count: 0,
              has_door: false,
              walkable: true,
            },
          ],
          chairs: [],
          tables: [],
          kitchens: [],
          drinks: [],
        }),
    );

    await expect(authority.loadServiceTopology()).rejects.toThrow(
      'duplicate service topology cell',
    );
  });

  it('fails closed on malformed success payloads and bounded public errors', async () => {
    const malformed = new HttpRestaurantAuthority(
      '/api/v1',
      async () => okJson({ items: [] }),
    );
    await expect(malformed.loadRestaurant()).rejects.toThrow(
      'Malformed authoritative restaurant layout',
    );

    const denied = new HttpRestaurantAuthority(
      '/api/v1',
      async () =>
        new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await expect(denied.loadRestaurant()).rejects.toEqual(
      new RestaurantAuthorityError(401, 'UNAUTHENTICATED'),
    );
  });

  it('rejects inconsistent authoritative inventory arithmetic', async () => {
    const authority = new HttpRestaurantAuthority(
      '/api/v1',
      async () =>
        okJson({
          room: {
            inside_x: 8,
            inside_y: 8,
            outside_x: 0,
            outside_y: 0,
          },
          next_instance_id: 1,
          items: [],
          floor_tiles: [],

          wallpapers: [],
          inventory: [
            {
              item_id: 10,
              owned: 1,
              placed: 1,
              available: 1,
            },
          ],
        }),
    );

    await expect(authority.loadRestaurant()).rejects.toThrow(
      'Malformed authoritative inventory invariant',
    );
  });

  it('rejects duplicate ids and inventory counts that disagree with persisted items', async () => {
    const duplicateInstance = new HttpRestaurantAuthority(
      '/api/v1',
      async () =>
        okJson({
          room: { inside_x: 8, inside_y: 8, outside_x: 0, outside_y: 0 },
          next_instance_id: 3,
          items: [
            {
              instance_id: 1,
              item_id: 10,
              tile_x: 2,
              tile_y: 2,
              rotation: 0,
              room_index: 0,
            },
            {
              instance_id: 1,
              item_id: 10,
              tile_x: 4,
              tile_y: 2,
              rotation: 0,
              room_index: 0,
            },
          ],
          floor_tiles: [],

          wallpapers: [],
          inventory: [
            { item_id: 10, owned: 2, placed: 2, available: 0 },
          ],
        }),
    );
    await expect(duplicateInstance.loadRestaurant()).rejects.toThrow(
      'duplicate instance id',
    );

    const wrongPlacedCount = new HttpRestaurantAuthority(
      '/api/v1',
      async () =>
        okJson({
          room: { inside_x: 8, inside_y: 8, outside_x: 0, outside_y: 0 },
          next_instance_id: 2,
          items: [
            {
              instance_id: 1,
              item_id: 10,
              tile_x: 2,
              tile_y: 2,
              rotation: 0,
              room_index: 0,
            },
          ],
          floor_tiles: [],

          wallpapers: [],
          inventory: [
            { item_id: 10, owned: 2, placed: 0, available: 2 },
          ],
        }),
    );
    await expect(wrongPlacedCount.loadRestaurant()).rejects.toThrow(
      'placed inventory count',
    );
  });

  it('rejects regressive instance sequences and unsupported room indexes', async () => {
    const sequence = new HttpRestaurantAuthority(
      '/api/v1',
      async () =>
        okJson({
          room: { inside_x: 8, inside_y: 8, outside_x: 0, outside_y: 0 },
          next_instance_id: 1,
          items: [
            {
              instance_id: 1,
              item_id: 10,
              tile_x: 2,
              tile_y: 2,
              rotation: 0,
              room_index: 0,
            },
          ],
          floor_tiles: [],

          wallpapers: [],
          inventory: [
            { item_id: 10, owned: 1, placed: 1, available: 0 },
          ],
        }),
    );
    await expect(sequence.loadRestaurant()).rejects.toThrow(
      'next instance id',
    );

    const roomIndex = new HttpRestaurantAuthority(
      '/api/v1',
      async () =>
        okJson({
          room: { inside_x: 8, inside_y: 8, outside_x: 0, outside_y: 0 },
          next_instance_id: 2,
          items: [
            {
              instance_id: 1,
              item_id: 10,
              tile_x: 2,
              tile_y: 2,
              rotation: 0,
              room_index: 9,
            },
          ],
          floor_tiles: [],

          wallpapers: [],
          inventory: [
            { item_id: 10, owned: 1, placed: 1, available: 0 },
          ],
        }),
    );
    await expect(roomIndex.loadRestaurant()).rejects.toThrow(
      'room index',
    );
  });

  it('rejects cross-origin API roots and invalid placement commands locally', async () => {
    expect(
      () => new HttpRestaurantAuthority('https://evil.example/api'),
    ).toThrow('same-origin');

    const authority = new HttpRestaurantAuthority(
      '/api/v1',
      vi.fn(async () => okJson({})),
    );
    await expect(
      authority.placeItem(
        { itemId: 10, tileX: 2, tileY: 3, rotation: 16 },
        'mutation-1',
      ),
    ).rejects.toThrow('Invalid Restaurant City placement command');
  });
});

describe('restaurant mutation ids', () => {
  const uuid = () => '00000000-0000-4000-8000-000000000001';

  it('keeps operation-specific bounded idempotency namespaces', () => {
    expect(createPlacementMutationId(uuid)).toBe(
      'rc-placement-00000000-0000-4000-8000-000000000001',
    );
    expect(createFloorTileMutationId(uuid)).toBe(
      'rc-floor-00000000-0000-4000-8000-000000000001',
    );
    expect(createWallpaperMutationId(uuid)).toBe(
      'rc-wallpaper-00000000-0000-4000-8000-000000000001',
    );
    expect(createTransformMutationId(uuid)).toBe(
      'rc-transform-00000000-0000-4000-8000-000000000001',
    );
    expect(createRemoveMutationId(uuid)).toBe(
      'rc-remove-00000000-0000-4000-8000-000000000001',
    );
  });
});
