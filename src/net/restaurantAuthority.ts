export interface AuthoritativeRoom {
  readonly insideX: number;
  readonly insideY: number;
  readonly outsideX: number;
  readonly outsideY: number;
}

export interface AuthoritativePlacedItem {
  readonly instanceId: number;
  readonly itemId: number;
  readonly tileX: number;
  readonly tileY: number;
  readonly rotation: number;
  readonly roomIndex: number;
}

export interface AuthoritativeInventoryAvailability {
  readonly itemId: number;
  readonly owned: number;
  readonly placed: number;
  readonly available: number;
}

export interface RestaurantLayout {
  readonly room: AuthoritativeRoom;
  readonly nextInstanceId: number;
  readonly items: readonly AuthoritativePlacedItem[];
  readonly inventory: readonly AuthoritativeInventoryAvailability[];
}

export interface PlacementCommand {
  readonly itemId: number;
  readonly tileX: number;
  readonly tileY: number;
  readonly rotation: number;
}

export interface TransformCommand {
  readonly tileX: number;
  readonly tileY: number;
  readonly rotation: number;
}

export interface PlacementCommit {
  readonly outcome: 'applied' | 'duplicate';
  readonly item: AuthoritativePlacedItem;
}

export interface RestaurantAuthority {
  loadRestaurant(): Promise<RestaurantLayout>;
  placeItem(
    command: PlacementCommand,
    mutationId: string,
  ): Promise<PlacementCommit>;
  transformItem(
    instanceId: number,
    command: TransformCommand,
    mutationId: string,
  ): Promise<PlacementCommit>;
  removeItem(
    instanceId: number,
    mutationId: string,
  ): Promise<PlacementCommit>;
}

export class RestaurantAuthorityError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`Restaurant authority request failed: ${code} (HTTP ${status})`);
    this.name = 'RestaurantAuthorityError';
    this.status = status;
    this.code = code;
  }
}

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function sameOriginGlobalFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  // Window.fetch is a Web-IDL method in browsers and must keep the global
  // receiver. Calling a detached native fetch as this.fetcher(...) can bind the
  // authority instance as receiver and Chromium rejects it as Illegal invocation.
  return globalThis.fetch(input, init);
}

const DEFAULT_BASE_PATH = '/api/v1';
const MAX_MUTATION_ID_BYTES = 128;
// Trusted placement catalog V2 derives per-item rotation_count from recovered
// RoomItem MovieClip frames and caps it at 16. The transport therefore accepts
// the full historical index range; item-specific validity remains authoritative
// in the renderer/catalog and Rust service.
const MAX_HISTORICAL_ROTATION_INDEX = 15;

export class HttpRestaurantAuthority implements RestaurantAuthority {
  private readonly basePath: string;
  private readonly fetcher: Fetcher;

  constructor(
    basePath = DEFAULT_BASE_PATH,
    fetcher: Fetcher = sameOriginGlobalFetch,
  ) {
    if (
      !basePath.startsWith('/') ||
      basePath.startsWith('//') ||
      basePath.includes('://') ||
      basePath.includes('?') ||
      basePath.includes('#')
    ) {
      throw new Error('Restaurant authority base path must be same-origin');
    }

    this.basePath = basePath.replace(/\/$/, '');
    this.fetcher = fetcher;
  }

  async loadRestaurant(): Promise<RestaurantLayout> {
    const response = await this.fetcher(`${this.basePath}/restaurant`, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw await authorityError(response);
    }

    return parseRestaurantLayout(await response.json());
  }

  async placeItem(
    command: PlacementCommand,
    mutationId: string,
  ): Promise<PlacementCommit> {
    validateMutationId(mutationId);
    validatePlacementCommand(command);

    const response = await this.fetcher(
      `${this.basePath}/restaurant/placements`,
      {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': mutationId,
        },
        body: JSON.stringify({
          item_id: command.itemId,
          tile_x: command.tileX,
          tile_y: command.tileY,
          rotation: command.rotation,
        }),
      },
    );

    if (!response.ok) {
      throw await authorityError(response);
    }

    return parsePlacementCommit(await response.json());
  }

  async transformItem(
    instanceId: number,
    command: TransformCommand,
    mutationId: string,
  ): Promise<PlacementCommit> {
    validateInstanceId(instanceId);
    validateMutationId(mutationId);
    validateTransformCommand(command);

    const response = await this.fetcher(
      `${this.basePath}/restaurant/placements/${instanceId}`,
      {
        method: 'PATCH',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': mutationId,
        },
        body: JSON.stringify({
          tile_x: command.tileX,
          tile_y: command.tileY,
          rotation: command.rotation,
        }),
      },
    );

    if (!response.ok) {
      throw await authorityError(response);
    }

    return parsePlacementCommit(await response.json());
  }

  async removeItem(
    instanceId: number,
    mutationId: string,
  ): Promise<PlacementCommit> {
    validateInstanceId(instanceId);
    validateMutationId(mutationId);

    const response = await this.fetcher(
      `${this.basePath}/restaurant/placements/${instanceId}`,
      {
        method: 'DELETE',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Idempotency-Key': mutationId,
        },
      },
    );

    if (!response.ok) {
      throw await authorityError(response);
    }

    return parsePlacementCommit(await response.json());
  }
}

export function createPlacementMutationId(
  uuid: () => string = () => crypto.randomUUID(),
): string {
  return createMutationId('place', uuid);
}

export function createTransformMutationId(
  uuid: () => string = () => crypto.randomUUID(),
): string {
  return createMutationId('transform', uuid);
}

export function createRemoveMutationId(
  uuid: () => string = () => crypto.randomUUID(),
): string {
  return createMutationId('remove', uuid);
}

function createMutationId(
  operation: 'place' | 'transform' | 'remove',
  uuid: () => string,
): string {
  const value = `rc-${operation}-${uuid()}`;
  validateMutationId(value);
  return value;
}

function validateMutationId(value: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_MUTATION_ID_BYTES ||
    /\s/.test(value)
  ) {
    throw new Error('Invalid Restaurant City mutation id');
  }
}

function validatePlacementCommand(command: PlacementCommand): void {
  if (!isUInt32(command.itemId)) {
    throw new Error('Invalid Restaurant City placement command');
  }
  validateTransformCommand(command);
}

function validateTransformCommand(command: TransformCommand): void {
  if (
    !Number.isSafeInteger(command.tileX) ||
    !Number.isSafeInteger(command.tileY) ||
    !Number.isInteger(command.rotation) ||
    command.rotation < 0 ||
    command.rotation > MAX_HISTORICAL_ROTATION_INDEX
  ) {
    throw new Error('Invalid Restaurant City transform command');
  }
}

function validateInstanceId(instanceId: number): void {
  if (!Number.isSafeInteger(instanceId) || instanceId <= 0) {
    throw new Error('Invalid Restaurant City instance id');
  }
}

async function authorityError(
  response: Response,
): Promise<RestaurantAuthorityError> {
  let code = 'UNAVAILABLE';
  try {
    const value: unknown = await response.json();
    if (
      isObject(value) &&
      isObject(value.error) &&
      typeof value.error.code === 'string' &&
      /^[A-Z_]{1,64}$/.test(value.error.code)
    ) {
      code = value.error.code;
    }
  } catch {
    // Public failures intentionally remain coarse even if the body is missing.
  }
  return new RestaurantAuthorityError(response.status, code);
}

function parseRestaurantLayout(value: unknown): RestaurantLayout {
  if (
    !isObject(value) ||
    !isObject(value.room) ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.inventory)
  ) {
    throw new Error('Malformed authoritative restaurant layout');
  }

  const room = {
    insideX: requireUInt(value.room.inside_x, 'room.inside_x'),
    insideY: requireUInt(value.room.inside_y, 'room.inside_y'),
    outsideX: requireUInt(value.room.outside_x, 'room.outside_x'),
    outsideY: requireUInt(value.room.outside_y, 'room.outside_y'),
  };
  const nextInstanceId = requireSafeUInt(
    value.next_instance_id,
    'next_instance_id',
  );
  const items = value.items.map(parsePlacedItem);
  const inventory = value.inventory.map(parseInventoryAvailability);

  if (room.insideX === 0 || room.insideY === 0 || nextInstanceId === 0) {
    throw new Error('Malformed authoritative restaurant dimensions or sequence');
  }

  const instanceIds = new Set<number>();
  const placedByItem = new Map<number, number>();
  let maxInstanceId = 0;
  for (const item of items) {
    if (instanceIds.has(item.instanceId)) {
      throw new Error('Malformed authoritative duplicate instance id');
    }
    instanceIds.add(item.instanceId);
    maxInstanceId = Math.max(maxInstanceId, item.instanceId);
    placedByItem.set(item.itemId, (placedByItem.get(item.itemId) ?? 0) + 1);
  }

  if (maxInstanceId >= nextInstanceId) {
    throw new Error('Malformed authoritative next instance id');
  }

  const inventoryIds = new Set<number>();
  for (const entry of inventory) {
    if (inventoryIds.has(entry.itemId)) {
      throw new Error('Malformed authoritative duplicate inventory item');
    }
    inventoryIds.add(entry.itemId);
    if ((placedByItem.get(entry.itemId) ?? 0) !== entry.placed) {
      throw new Error('Malformed authoritative placed inventory count');
    }
  }

  for (const itemId of placedByItem.keys()) {
    if (!inventoryIds.has(itemId)) {
      throw new Error('Malformed authoritative missing inventory entry');
    }
  }

  return {
    room,
    nextInstanceId,
    items,
    inventory,
  };
}

function parseInventoryAvailability(
  value: unknown,
): AuthoritativeInventoryAvailability {
  if (!isObject(value)) {
    throw new Error('Malformed authoritative inventory availability');
  }

  const owned = requireUInt(value.owned, 'inventory.owned');
  const placed = requireUInt(value.placed, 'inventory.placed');
  const available = requireUInt(value.available, 'inventory.available');
  if (placed > owned || available !== owned - placed) {
    throw new Error('Malformed authoritative inventory invariant');
  }

  return {
    itemId: requireUInt(value.item_id, 'inventory.item_id'),
    owned,
    placed,
    available,
  };
}

function parsePlacementCommit(value: unknown): PlacementCommit {
  if (
    !isObject(value) ||
    (value.outcome !== 'applied' && value.outcome !== 'duplicate')
  ) {
    throw new Error('Malformed authoritative placement response');
  }

  return {
    outcome: value.outcome,
    item: parsePlacedItem(value.item),
  };
}

function parsePlacedItem(value: unknown): AuthoritativePlacedItem {
  if (!isObject(value)) {
    throw new Error('Malformed authoritative placed item');
  }

  const rotation = requireUInt(value.rotation, 'item.rotation');
  if (rotation > MAX_HISTORICAL_ROTATION_INDEX) {
    throw new Error('Malformed authoritative item rotation');
  }

  return {
    instanceId: requireSafeUInt(value.instance_id, 'item.instance_id'),
    itemId: requireUInt(value.item_id, 'item.item_id'),
    tileX: requireSafeInt(value.tile_x, 'item.tile_x'),
    tileY: requireSafeInt(value.tile_y, 'item.tile_y'),
    rotation,
    roomIndex: requireRoomIndex(value.room_index),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUInt32(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffff_ffff
  );
}

function requireUInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !isUInt32(value)) {
    throw new Error(`Malformed authoritative field: ${field}`);
  }
  return value;
}

function requireSafeUInt(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`Malformed authoritative field: ${field}`);
  }
  return value;
}

function requireSafeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Malformed authoritative field: ${field}`);
  }
  return value;
}


function requireRoomIndex(value: unknown): number {
  const roomIndex = requireUInt(value, 'item.room_index');
  if (roomIndex !== 0 && roomIndex !== 1) {
    throw new Error('Malformed authoritative room index');
  }
  return roomIndex;
}
