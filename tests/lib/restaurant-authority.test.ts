import { describe, expect, it, vi } from 'vitest';
import {
  HttpRestaurantAuthority,
  RestaurantAuthorityError,
  createPlacementMutationId,
} from '../../src/net/restaurantAuthority';

function okJson(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('HttpRestaurantAuthority', () => {
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
      }),
    );

    const authority = new HttpRestaurantAuthority('/api/v1', fetcher);
    const layout = await authority.loadRestaurant();

    expect(layout.items[0]?.instanceId).toBe(1);
    expect(layout.room.insideX).toBe(8);

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('/api/v1/restaurant');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.cache).toBe('no-store');
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
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
        { itemId: 10, tileX: 2, tileY: 3, rotation: 4 },
        'mutation-1',
      ),
    ).rejects.toThrow('Invalid Restaurant City placement command');
  });
});

describe('createPlacementMutationId', () => {
  it('creates a bounded mutation id from the injected UUID source', () => {
    expect(createPlacementMutationId(() => '00000000-0000-4000-8000-000000000001'))
      .toBe('rc-placement-00000000-0000-4000-8000-000000000001');
  });
});
