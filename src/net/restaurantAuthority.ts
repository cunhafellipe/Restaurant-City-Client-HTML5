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

export interface AuthoritativeFloorTile {
  readonly itemId: number;
  readonly tileX: number;
  readonly tileY: number;
  readonly roomIndex: number;
}

export interface AuthoritativeWallpaper {
  readonly itemId: number;
  readonly rotation: 0 | 1;
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
  readonly floorTiles: readonly AuthoritativeFloorTile[];
  readonly wallpapers: readonly AuthoritativeWallpaper[];
  readonly inventory: readonly AuthoritativeInventoryAvailability[];
}

export interface AuthoritativeServiceTopologyCell {
  readonly tileX: number;
  readonly tileY: number;
  readonly wall: boolean;
  readonly itemCount: number;
  readonly hasDoor: boolean;
  readonly walkable: boolean;
}

export interface AuthoritativeServiceChair {
  readonly instanceId: number;
  readonly tileX: number;
  readonly tileY: number;
  readonly rotation: number;
  readonly toilet: boolean;
  readonly mealSeat: boolean;
  readonly facingTileX: number;
  readonly facingTileY: number;
  readonly tableInstanceId: number | null;
}

export interface AuthoritativeServiceTable {
  readonly instanceId: number;
  readonly tileX: number;
  readonly tileY: number;
  readonly itemCountOnTile: number;
  readonly hasTableTopOrder: boolean;
  readonly free: boolean;
}

export interface AuthoritativeServiceKitchen {
  readonly instanceId: number;
  readonly tileX: number;
  readonly tileY: number;
}

export interface AuthoritativeServiceDrink {
  readonly instanceId: number;
  readonly tileX: number;
  readonly tileY: number;
}

export interface RestaurantServiceTopology {
  readonly source: {
    readonly room: AuthoritativeRoom;
    readonly items: readonly AuthoritativePlacedItem[];
  };
  readonly cells: readonly AuthoritativeServiceTopologyCell[];
  readonly chairs: readonly AuthoritativeServiceChair[];
  readonly tables: readonly AuthoritativeServiceTable[];
  readonly kitchens: readonly AuthoritativeServiceKitchen[];
  readonly drinks: readonly AuthoritativeServiceDrink[];
}

export type AuthoritativeCustomerServiceState =
  | 'admitted'
  | 'walking-to-chair'
  | 'deciding'
  | 'waiting'
  | 'waiting-for-food'
  | 'eating'
  | 'paying'
  | 'leaving'
  | 'left';

export type AuthoritativeOrderServiceState =
  | 'created'
  | 'queued'
  | 'cooking'
  | 'completed'
  | 'waiter-collecting'
  | 'serving'
  | 'empty-plate'
  | 'settled';

export interface AuthoritativeServicePath {
  readonly kind: 'customer-to-chair';
  readonly fromTileX: number;
  readonly fromTileY: number;
  readonly toTileX: number;
  readonly toTileY: number;
  readonly stepIndex: number;
  readonly stepCount: number;
  readonly segmentStartedAtMs: number;
  readonly segmentCompletesAtMs: number;
  readonly pathStartedAtMs: number;
  readonly pathCompletesAtMs: number;
  readonly pathRemainingMs: number;
}

export interface RestaurantActiveService {
  readonly serviceId: number;
  readonly restaurantMutationSequence: number;
  readonly customerId: number;
  readonly orderId: number;
  readonly chairInstanceId: number;
  readonly tableInstanceId: number;
  readonly chefEmployeeId: number;
  readonly kitchenInstanceId: number;
  readonly waiterEmployeeId: number;
  readonly waiterTileX: number;
  readonly waiterTileY: number;
  readonly customerState: AuthoritativeCustomerServiceState;
  readonly orderState: AuthoritativeOrderServiceState;
  readonly customerTimerMs: number | null;
  readonly orderTimerMs: number | null;
  readonly serverNowMs: number;
  readonly customerDeadlineAtMs: number | null;
  readonly orderDeadlineAtMs: number | null;
  readonly customerRemainingMs: number | null;
  readonly orderRemainingMs: number | null;
  readonly path: AuthoritativeServicePath | null;
}

export interface RestaurantAuthoritativeSnapshot {
  readonly layout: RestaurantLayout;
  readonly topology: RestaurantServiceTopology;
  readonly activeService: RestaurantActiveService | null;
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

export interface FloorTileCommand {
  readonly itemId: number;
  readonly tileX: number;
  readonly tileY: number;
}

export interface WallpaperCommand {
  readonly itemId: number;
  readonly tileX: number;
  readonly tileY: number;
}

export interface PlacementCommit {
  readonly outcome: 'applied' | 'duplicate';
  readonly item: AuthoritativePlacedItem;
}

export interface FloorTileCommit {
  readonly outcome: 'applied' | 'duplicate';
  readonly tile: AuthoritativeFloorTile;
}

export interface WallpaperCommit {
  readonly outcome: 'applied' | 'duplicate';
  readonly wallpaper: AuthoritativeWallpaper;
}

export interface RestaurantAuthority {
  loadRestaurant(): Promise<RestaurantLayout>;
  loadServiceTopology(): Promise<RestaurantServiceTopology>;
  loadActiveService(): Promise<RestaurantActiveService | null>;
  loadRestaurantSnapshot(): Promise<RestaurantAuthoritativeSnapshot>;
  placeItem(
    command: PlacementCommand,
    mutationId: string,
  ): Promise<PlacementCommit>;
  paintFloorTile(
    command: FloorTileCommand,
    mutationId: string,
  ): Promise<FloorTileCommit>;
  applyWallpaper(
    command: WallpaperCommand,
    mutationId: string,
  ): Promise<WallpaperCommit>;
  removeWallpaper(rotation: 0 | 1, mutationId: string): Promise<WallpaperCommit>;
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

  async loadServiceTopology(): Promise<RestaurantServiceTopology> {
    const response = await this.fetcher(
      `${this.basePath}/restaurant/topology`,
      {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
        },
      },
    );

    if (!response.ok) {
      throw await authorityError(response);
    }

    return parseServiceTopology(await response.json());
  }

  async loadActiveService(): Promise<RestaurantActiveService | null> {
    const response = await this.fetcher(
      `${this.basePath}/restaurant/service`,
      {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
        },
      },
    );

    if (!response.ok) {
      throw await authorityError(response);
    }

    return parseActiveServiceEnvelope(await response.json());
  }

  async loadRestaurantSnapshot(): Promise<RestaurantAuthoritativeSnapshot> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const layout = await this.loadRestaurant();
      const topology = await this.loadServiceTopology();
      if (!serviceTopologyMatchesLayout(topology, layout)) {
        continue;
      }

      const activeService = await this.loadActiveService();
      if (activeServiceMatchesTopology(activeService, topology)) {
        return { layout, topology, activeService };
      }
    }
    throw new Error(
      'Authoritative restaurant, service topology, and active service do not form a synchronized snapshot',
    );
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

  async paintFloorTile(
    command: FloorTileCommand,
    mutationId: string,
  ): Promise<FloorTileCommit> {
    validateMutationId(mutationId);
    validateFloorTileCommand(command);

    const response = await this.fetcher(
      `${this.basePath}/restaurant/floor-tiles`,
      {
        method: 'PUT',
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
        }),
      },
    );

    if (!response.ok) {
      throw await authorityError(response);
    }

    return parseFloorTileCommit(await response.json());
  }

  async applyWallpaper(
    command: WallpaperCommand,
    mutationId: string,
  ): Promise<WallpaperCommit> {
    validateMutationId(mutationId);
    validateWallpaperCommand(command);

    const response = await this.fetcher(
      `${this.basePath}/restaurant/wallpapers`,
      {
        method: 'PUT',
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
        }),
      },
    );

    if (!response.ok) {
      throw await authorityError(response);
    }

    return parseWallpaperCommit(await response.json());
  }

  async removeWallpaper(
    rotation: 0 | 1,
    mutationId: string,
  ): Promise<WallpaperCommit> {
    validateWallpaperRotation(rotation);
    validateMutationId(mutationId);

    const response = await this.fetcher(
      `${this.basePath}/restaurant/wallpapers/${rotation}`,
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

    return parseWallpaperCommit(await response.json());
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
  return createMutationId('placement', uuid);
}

export function createFloorTileMutationId(
  uuid: () => string = () => crypto.randomUUID(),
): string {
  return createMutationId('floor', uuid);
}

export function createWallpaperMutationId(
  uuid: () => string = () => crypto.randomUUID(),
): string {
  return createMutationId('wallpaper', uuid);
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
  operation: 'placement' | 'floor' | 'wallpaper' | 'transform' | 'remove',
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
  if (!isUInt32(command.itemId) || !isValidTransformCommand(command)) {
    throw new Error('Invalid Restaurant City placement command');
  }
}

function validateFloorTileCommand(command: FloorTileCommand): void {
  if (
    !isUInt32(command.itemId) ||
    !Number.isSafeInteger(command.tileX) ||
    !Number.isSafeInteger(command.tileY)
  ) {
    throw new Error('Invalid Restaurant City floor tile command');
  }
}

function validateWallpaperCommand(command: WallpaperCommand): void {
  if (
    !isUInt32(command.itemId) ||
    !Number.isSafeInteger(command.tileX) ||
    !Number.isSafeInteger(command.tileY)
  ) {
    throw new Error('Invalid Restaurant City wallpaper command');
  }
}

function validateWallpaperRotation(rotation: number): asserts rotation is 0 | 1 {
  if (rotation !== 0 && rotation !== 1) {
    throw new Error('Invalid Restaurant City wallpaper rotation');
  }
}

function validateTransformCommand(command: TransformCommand): void {
  if (!isValidTransformCommand(command)) {
    throw new Error('Invalid Restaurant City transform command');
  }
}

function isValidTransformCommand(command: TransformCommand): boolean {
  return (
    Number.isSafeInteger(command.tileX) &&
    Number.isSafeInteger(command.tileY) &&
    Number.isInteger(command.rotation) &&
    command.rotation >= 0 &&
    command.rotation <= MAX_HISTORICAL_ROTATION_INDEX
  );
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

export function serviceTopologyMatchesLayout(
  topology: RestaurantServiceTopology,
  layout: RestaurantLayout,
): boolean {
  const room = topology.source.room;
  if (
    room.insideX !== layout.room.insideX ||
    room.insideY !== layout.room.insideY ||
    room.outsideX !== layout.room.outsideX ||
    room.outsideY !== layout.room.outsideY ||
    topology.source.items.length !== layout.items.length
  ) {
    return false;
  }

  return topology.source.items.every((source, index) => {
    const current = layout.items[index];
    return (
      current !== undefined &&
      source.instanceId === current.instanceId &&
      source.itemId === current.itemId &&
      source.tileX === current.tileX &&
      source.tileY === current.tileY &&
      source.rotation === current.rotation &&
      source.roomIndex === current.roomIndex
    );
  });
}

const CUSTOMER_SERVICE_STATES = new Set<AuthoritativeCustomerServiceState>([
  'admitted',
  'walking-to-chair',
  'deciding',
  'waiting',
  'waiting-for-food',
  'eating',
  'paying',
  'leaving',
  'left',
]);

const ORDER_SERVICE_STATES = new Set<AuthoritativeOrderServiceState>([
  'created',
  'queued',
  'cooking',
  'completed',
  'waiter-collecting',
  'serving',
  'empty-plate',
  'settled',
]);

export function activeServiceMatchesTopology(
  active: RestaurantActiveService | null,
  topology: RestaurantServiceTopology,
): boolean {
  if (active === null) return true;

  const chair = topology.chairs.find(
    (candidate) => candidate.instanceId === active.chairInstanceId,
  );
  const table = topology.tables.find(
    (candidate) => candidate.instanceId === active.tableInstanceId,
  );
  const kitchen = topology.kitchens.find(
    (candidate) => candidate.instanceId === active.kitchenInstanceId,
  );
  const waiterCell = topology.cells.find(
    (cell) =>
      cell.tileX === active.waiterTileX && cell.tileY === active.waiterTileY,
  );

  return (
    chair !== undefined &&
    chair.mealSeat &&
    chair.tableInstanceId === active.tableInstanceId &&
    table !== undefined &&
    kitchen !== undefined &&
    waiterCell !== undefined &&
    waiterCell.walkable
  );
}

function parseActiveServiceEnvelope(value: unknown): RestaurantActiveService | null {
  if (!isObject(value) || !('active' in value)) {
    throw new Error('Malformed authoritative active service envelope');
  }
  const serverNowMs = requireSafeUInt(
    value.server_now_ms,
    'active_service.server_now_ms',
  );
  if (value.active === null) return null;
  if (!isObject(value.active)) {
    throw new Error('Malformed authoritative active service');
  }

  const customerState = value.active.customer_state;
  const orderState = value.active.order_state;
  if (
    typeof customerState !== 'string' ||
    !CUSTOMER_SERVICE_STATES.has(
      customerState as AuthoritativeCustomerServiceState,
    ) ||
    typeof orderState !== 'string' ||
    !ORDER_SERVICE_STATES.has(orderState as AuthoritativeOrderServiceState)
  ) {
    throw new Error('Malformed authoritative active service state');
  }

  const serviceId = requirePositiveSafeUInt(
    value.active.service_id,
    'active_service.service_id',
  );
  const customerId = requirePositiveSafeUInt(
    value.active.customer_id,
    'active_service.customer_id',
  );
  const orderId = requirePositiveSafeUInt(
    value.active.order_id,
    'active_service.order_id',
  );
  if (customerId !== serviceId || orderId !== serviceId) {
    throw new Error('Malformed authoritative active service identity');
  }

  const active: RestaurantActiveService = {
    serviceId,
    restaurantMutationSequence: requirePositiveSafeUInt(
      value.active.restaurant_mutation_sequence,
      'active_service.restaurant_mutation_sequence',
    ),
    customerId,
    orderId,
    chairInstanceId: requirePositiveSafeUInt(
      value.active.chair_instance_id,
      'active_service.chair_instance_id',
    ),
    tableInstanceId: requirePositiveSafeUInt(
      value.active.table_instance_id,
      'active_service.table_instance_id',
    ),
    chefEmployeeId: requirePositiveSafeUInt(
      value.active.chef_employee_id,
      'active_service.chef_employee_id',
    ),
    kitchenInstanceId: requirePositiveSafeUInt(
      value.active.kitchen_instance_id,
      'active_service.kitchen_instance_id',
    ),
    waiterEmployeeId: requirePositiveSafeUInt(
      value.active.waiter_employee_id,
      'active_service.waiter_employee_id',
    ),
    waiterTileX: requireSafeInt(
      value.active.waiter_tile_x,
      'active_service.waiter_tile_x',
    ),
    waiterTileY: requireSafeInt(
      value.active.waiter_tile_y,
      'active_service.waiter_tile_y',
    ),
    customerState: customerState as AuthoritativeCustomerServiceState,
    orderState: orderState as AuthoritativeOrderServiceState,
    customerTimerMs: requireNullableSafeUInt(
      value.active.customer_timer_ms,
      'active_service.customer_timer_ms',
    ),
    orderTimerMs: requireNullableSafeUInt(
      value.active.order_timer_ms,
      'active_service.order_timer_ms',
    ),
    serverNowMs,
    customerDeadlineAtMs: requireNullableSafeUInt(
      value.active.customer_deadline_at_ms,
      'active_service.customer_deadline_at_ms',
    ),
    orderDeadlineAtMs: requireNullableSafeUInt(
      value.active.order_deadline_at_ms,
      'active_service.order_deadline_at_ms',
    ),
    customerRemainingMs: requireNullableSafeUInt(
      value.active.customer_remaining_ms,
      'active_service.customer_remaining_ms',
    ),
    orderRemainingMs: requireNullableSafeUInt(
      value.active.order_remaining_ms,
      'active_service.order_remaining_ms',
    ),
    path: parseActiveServicePath(
      value.active.path,
      serverNowMs,
      customerState as AuthoritativeCustomerServiceState,
    ),
  };

  const expectedCustomerRemaining =
    active.customerDeadlineAtMs === null
      ? null
      : Math.max(active.customerDeadlineAtMs - active.serverNowMs, 0);
  const expectedOrderRemaining =
    active.orderDeadlineAtMs === null
      ? null
      : Math.max(active.orderDeadlineAtMs - active.serverNowMs, 0);
  if (
    (active.customerTimerMs === null) !==
      (active.customerDeadlineAtMs === null) ||
    (active.orderTimerMs === null) !== (active.orderDeadlineAtMs === null) ||
    active.customerRemainingMs !== expectedCustomerRemaining ||
    active.orderRemainingMs !== expectedOrderRemaining
  ) {
    throw new Error('Malformed authoritative active service timing');
  }

  return active;
}

function parseActiveServicePath(
  value: unknown,
  serverNowMs: number,
  customerState: AuthoritativeCustomerServiceState,
): AuthoritativeServicePath | null {
  if (value === null) {
    if (customerState === 'walking-to-chair') {
      throw new Error('Malformed authoritative active service path');
    }
    return null;
  }
  if (!isObject(value) || value.kind !== 'customer-to-chair') {
    throw new Error('Malformed authoritative active service path');
  }
  if (customerState !== 'walking-to-chair') {
    throw new Error('Malformed authoritative active service path state');
  }

  const path: AuthoritativeServicePath = {
    kind: 'customer-to-chair',
    fromTileX: requireSafeInt(value.from_tile_x, 'active_service.path.from_tile_x'),
    fromTileY: requireSafeInt(value.from_tile_y, 'active_service.path.from_tile_y'),
    toTileX: requireSafeInt(value.to_tile_x, 'active_service.path.to_tile_x'),
    toTileY: requireSafeInt(value.to_tile_y, 'active_service.path.to_tile_y'),
    stepIndex: requireSafeUInt(value.step_index, 'active_service.path.step_index'),
    stepCount: requireSafeUInt(value.step_count, 'active_service.path.step_count'),
    segmentStartedAtMs: requireSafeUInt(
      value.segment_started_at_ms,
      'active_service.path.segment_started_at_ms',
    ),
    segmentCompletesAtMs: requireSafeUInt(
      value.segment_completes_at_ms,
      'active_service.path.segment_completes_at_ms',
    ),
    pathStartedAtMs: requireSafeUInt(
      value.path_started_at_ms,
      'active_service.path.path_started_at_ms',
    ),
    pathCompletesAtMs: requireSafeUInt(
      value.path_completes_at_ms,
      'active_service.path.path_completes_at_ms',
    ),
    pathRemainingMs: requireSafeUInt(
      value.path_remaining_ms,
      'active_service.path.path_remaining_ms',
    ),
  };

  if (
    path.stepCount === 0 ||
    path.stepIndex >= path.stepCount ||
    path.pathStartedAtMs > path.segmentStartedAtMs ||
    path.segmentStartedAtMs > serverNowMs ||
    serverNowMs >= path.segmentCompletesAtMs ||
    path.segmentCompletesAtMs > path.pathCompletesAtMs ||
    path.pathRemainingMs !== path.pathCompletesAtMs - serverNowMs
  ) {
    throw new Error('Malformed authoritative active service path timing');
  }

  return path;
}

function parseServiceTopology(value: unknown): RestaurantServiceTopology {
  if (
    !isObject(value) ||
    !isObject(value.source) ||
    !isObject(value.source.room) ||
    !Array.isArray(value.source.items) ||
    !Array.isArray(value.cells) ||
    !Array.isArray(value.chairs) ||
    !Array.isArray(value.tables) ||
    !Array.isArray(value.kitchens) ||
    !Array.isArray(value.drinks)
  ) {
    throw new Error('Malformed authoritative service topology');
  }

  const sourceRoom = {
    insideX: requireUInt(value.source.room.inside_x, 'topology.source.room.inside_x'),
    insideY: requireUInt(value.source.room.inside_y, 'topology.source.room.inside_y'),
    outsideX: requireUInt(value.source.room.outside_x, 'topology.source.room.outside_x'),
    outsideY: requireUInt(value.source.room.outside_y, 'topology.source.room.outside_y'),
  };
  if (sourceRoom.insideX === 0 || sourceRoom.insideY === 0) {
    throw new Error('Malformed authoritative service topology room');
  }

  const sourceItems = value.source.items.map(parsePlacedItem);
  const sourceInstanceIds = new Set<number>();
  for (const item of sourceItems) {
    if (sourceInstanceIds.has(item.instanceId)) {
      throw new Error('Malformed authoritative service topology source items');
    }
    sourceInstanceIds.add(item.instanceId);
  }

  const cells = value.cells.map((cell) => {
    if (!isObject(cell)) {
      throw new Error('Malformed authoritative service topology cell');
    }
    return {
      tileX: requireSafeInt(cell.tile_x, 'topology.cell.tile_x'),
      tileY: requireSafeInt(cell.tile_y, 'topology.cell.tile_y'),
      wall: requireBoolean(cell.wall, 'topology.cell.wall'),
      itemCount: requireUInt(cell.item_count, 'topology.cell.item_count'),
      hasDoor: requireBoolean(cell.has_door, 'topology.cell.has_door'),
      walkable: requireBoolean(cell.walkable, 'topology.cell.walkable'),
    };
  });
  const cellKeys = new Set<string>();
  for (const cell of cells) {
    const key = `${cell.tileX}:${cell.tileY}`;
    if (cellKeys.has(key)) {
      throw new Error('Malformed authoritative duplicate service topology cell');
    }
    cellKeys.add(key);
  }

  const chairs = value.chairs.map((chair) => {
    if (!isObject(chair)) {
      throw new Error('Malformed authoritative service chair');
    }
    return {
      instanceId: requireSafeUInt(chair.instance_id, 'topology.chair.instance_id'),
      tileX: requireSafeInt(chair.tile_x, 'topology.chair.tile_x'),
      tileY: requireSafeInt(chair.tile_y, 'topology.chair.tile_y'),
      rotation: requireUInt(chair.rotation, 'topology.chair.rotation'),
      toilet: requireBoolean(chair.toilet, 'topology.chair.toilet'),
      mealSeat: requireBoolean(chair.meal_seat, 'topology.chair.meal_seat'),
      facingTileX: requireSafeInt(chair.facing_tile_x, 'topology.chair.facing_tile_x'),
      facingTileY: requireSafeInt(chair.facing_tile_y, 'topology.chair.facing_tile_y'),
      tableInstanceId: requireNullableSafeUInt(
        chair.table_instance_id,
        'topology.chair.table_instance_id',
      ),
    };
  });

  const tables = value.tables.map((table) => {
    if (!isObject(table)) {
      throw new Error('Malformed authoritative service table');
    }
    return {
      instanceId: requireSafeUInt(table.instance_id, 'topology.table.instance_id'),
      tileX: requireSafeInt(table.tile_x, 'topology.table.tile_x'),
      tileY: requireSafeInt(table.tile_y, 'topology.table.tile_y'),
      itemCountOnTile: requireUInt(
        table.item_count_on_tile,
        'topology.table.item_count_on_tile',
      ),
      hasTableTopOrder: requireBoolean(
        table.has_table_top_order,
        'topology.table.has_table_top_order',
      ),
      free: requireBoolean(table.free, 'topology.table.free'),
    };
  });

  const kitchens = value.kitchens.map((kitchen) => {
    if (!isObject(kitchen)) {
      throw new Error('Malformed authoritative service kitchen');
    }
    return {
      instanceId: requireSafeUInt(kitchen.instance_id, 'topology.kitchen.instance_id'),
      tileX: requireSafeInt(kitchen.tile_x, 'topology.kitchen.tile_x'),
      tileY: requireSafeInt(kitchen.tile_y, 'topology.kitchen.tile_y'),
    };
  });

  const drinks = value.drinks.map((drink) => {
    if (!isObject(drink)) {
      throw new Error('Malformed authoritative service drink');
    }
    return {
      instanceId: requireSafeUInt(drink.instance_id, 'topology.drink.instance_id'),
      tileX: requireSafeInt(drink.tile_x, 'topology.drink.tile_x'),
      tileY: requireSafeInt(drink.tile_y, 'topology.drink.tile_y'),
    };
  });

  return {
    source: { room: sourceRoom, items: sourceItems },
    cells,
    chairs,
    tables,
    kitchens,
    drinks,
  };
}

function parseRestaurantLayout(value: unknown): RestaurantLayout {
  if (
    !isObject(value) ||
    !isObject(value.room) ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.floor_tiles) ||
    !Array.isArray(value.wallpapers) ||
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
  const floorTiles = value.floor_tiles.map(parseFloorTile);
  const wallpapers = value.wallpapers.map(parseWallpaper);
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

  const floorKeys = new Set<string>();
  for (const tile of floorTiles) {
    const key = `${tile.roomIndex}:${tile.tileX}:${tile.tileY}`;
    if (floorKeys.has(key)) {
      throw new Error('Malformed authoritative duplicate floor tile cell');
    }
    floorKeys.add(key);
    placedByItem.set(tile.itemId, (placedByItem.get(tile.itemId) ?? 0) + 1);
  }

  const wallpaperRotations = new Set<number>();
  for (const wallpaper of wallpapers) {
    if (wallpaperRotations.has(wallpaper.rotation)) {
      throw new Error('Malformed authoritative duplicate wallpaper orientation');
    }
    wallpaperRotations.add(wallpaper.rotation);
    placedByItem.set(
      wallpaper.itemId,
      (placedByItem.get(wallpaper.itemId) ?? 0) + 1,
    );
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
    floorTiles,
    wallpapers,
    inventory,
  };
}

function parseFloorTile(value: unknown): AuthoritativeFloorTile {
  if (!isObject(value)) {
    throw new Error('Malformed authoritative floor tile');
  }
  return {
    itemId: requireUInt(value.item_id, 'floor_tile.item_id'),
    tileX: requireSafeInt(value.tile_x, 'floor_tile.tile_x'),
    tileY: requireSafeInt(value.tile_y, 'floor_tile.tile_y'),
    roomIndex: requireRoomIndex(value.room_index),
  };
}

function parseWallpaper(value: unknown): AuthoritativeWallpaper {
  if (!isObject(value)) {
    throw new Error('Malformed authoritative wallpaper');
  }
  const rotation = requireUInt(value.rotation, 'wallpaper.rotation');
  validateWallpaperRotation(rotation);
  return {
    itemId: requireUInt(value.item_id, 'wallpaper.item_id'),
    rotation,
  };
}

function parseWallpaperCommit(value: unknown): WallpaperCommit {
  if (
    !isObject(value) ||
    (value.outcome !== 'applied' && value.outcome !== 'duplicate')
  ) {
    throw new Error('Malformed authoritative wallpaper response');
  }
  return {
    outcome: value.outcome,
    wallpaper: parseWallpaper(value.wallpaper),
  };
}

function parseFloorTileCommit(value: unknown): FloorTileCommit {
  if (
    !isObject(value) ||
    (value.outcome !== 'applied' && value.outcome !== 'duplicate')
  ) {
    throw new Error('Malformed authoritative floor tile response');
  }
  return {
    outcome: value.outcome,
    tile: parseFloorTile(value.tile),
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

function requirePositiveSafeUInt(value: unknown, field: string): number {
  const parsed = requireSafeUInt(value, field);
  if (parsed === 0) {
    throw new Error(`Malformed authoritative field: ${field}`);
  }
  return parsed;
}

function requireSafeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Malformed authoritative field: ${field}`);
  }
  return value;
}


function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Malformed authoritative field: ${field}`);
  }
  return value;
}

function requireNullableSafeUInt(value: unknown, field: string): number | null {
  if (value === null) return null;
  return requireSafeUInt(value, field);
}

function requireRoomIndex(value: unknown): number {
  const roomIndex = requireUInt(value, 'item.room_index');
  if (roomIndex !== 0 && roomIndex !== 1) {
    throw new Error('Malformed authoritative room index');
  }
  return roomIndex;
}
