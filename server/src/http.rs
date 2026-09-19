//! Framework-independent HTTP/wire contract for the Restaurant City product.
//!
//! This module deliberately does not own sockets, TLS, routing, cookies or
//! ANEWON Platform authentication. A concrete HTTP adapter extracts the opaque
//! product-session token and supplies it with request bytes; the product
//! service verifies the Product-scoped session.

use crate::active_service::ActiveServiceRecord;
use crate::domain::MutationId;
use crate::gameplay::{CustomerServiceState, OrderServiceState};
use crate::placement::TilePoint;
use crate::platform::{PlatformSessionError, PlatformSessionVerifier};
use crate::restaurant::{
    AppliedWallpaper, FloorTileIntent, PaintedFloorTile, PlacedItem, PlacementIntent,
    WallpaperIntent, WallpaperOrientation,
};
use crate::service::{
    FloorTileMutationOutcome, InventoryAvailability, PlacementMutationOutcome, ProductServiceError,
    ProductStateStore, RestaurantProductService, RestaurantProductSnapshot,
    WallpaperMutationOutcome,
};
use crate::topology::{
    MAX_NUM_TILES_X, MAX_NUM_TILES_Y, ServiceLayoutSnapshot, facing_tile, is_meal_seat,
    is_table_free, table_for_chair,
};
use serde::{Deserialize, Serialize};

const MAX_BODY_BYTES: usize = 4 * 1024;
const MAX_SESSION_TOKEN_BYTES: usize = 2 * 1024;
const MAX_MUTATION_ID_BYTES: usize = 128;
// PlacementCatalog V2 bounds recovered RoomItem rotation_count to at most 16
// frames. HTTP accepts that transport range; per-item limits remain enforced by
// RestaurantState against the trusted catalog.
const MAX_HISTORICAL_ROTATION_INDEX: u8 = 15;

#[derive(Clone, Copy, Debug)]
pub struct ProductHttpContext<'a> {
    pub session_token: Option<&'a str>,
    pub mutation_id: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PublicProductError {
    InvalidRequest,
    Unauthenticated,
    Forbidden,
    Conflict,
    Unprocessable,
    Unavailable,
    Internal,
}

impl PublicProductError {
    pub const fn status_code(self) -> u16 {
        match self {
            Self::InvalidRequest => 400,
            Self::Unauthenticated => 401,
            Self::Forbidden => 403,
            Self::Conflict => 409,
            Self::Unprocessable => 422,
            Self::Unavailable => 503,
            Self::Internal => 500,
        }
    }

    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "INVALID_REQUEST",
            Self::Unauthenticated => "UNAUTHENTICATED",
            Self::Forbidden => "FORBIDDEN",
            Self::Conflict => "CONFLICT",
            Self::Unprocessable => "UNPROCESSABLE",
            Self::Unavailable => "UNAVAILABLE",
            Self::Internal => "INTERNAL",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PlacementRequestDto {
    item_id: u32,
    tile_x: i32,
    tile_y: i32,
    rotation: u8,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TransformRequestDto {
    tile_x: i32,
    tile_y: i32,
    rotation: u8,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FloorTileRequestDto {
    item_id: u32,
    tile_x: i32,
    tile_y: i32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WallpaperRequestDto {
    item_id: u32,
    tile_x: i32,
    tile_y: i32,
}

#[derive(Clone, Copy, Debug, Serialize, Eq, PartialEq)]
pub struct RoomResponse {
    pub inside_x: u32,
    pub inside_y: u32,
    pub outside_x: u32,
    pub outside_y: u32,
}

#[derive(Clone, Copy, Debug, Serialize, Eq, PartialEq)]
pub struct PlacedItemResponse {
    pub instance_id: u64,
    pub item_id: u32,
    pub tile_x: i32,
    pub tile_y: i32,
    pub rotation: u8,
    pub room_index: u8,
}

#[derive(Clone, Copy, Debug, Serialize, Eq, PartialEq)]
pub struct FloorTileResponse {
    pub item_id: u32,
    pub tile_x: i32,
    pub tile_y: i32,
    pub room_index: u8,
}

#[derive(Clone, Copy, Debug, Serialize, Eq, PartialEq)]
pub struct WallpaperResponse {
    pub item_id: u32,
    pub rotation: u8,
}

#[derive(Clone, Copy, Debug, Serialize, Eq, PartialEq)]
pub struct InventoryAvailabilityResponse {
    pub item_id: u32,
    pub owned: u32,
    pub placed: u32,
    pub available: u32,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
pub struct RestaurantLayoutResponse {
    pub room: RoomResponse,
    pub next_instance_id: u64,
    pub items: Vec<PlacedItemResponse>,
    pub floor_tiles: Vec<FloorTileResponse>,
    pub wallpapers: Vec<WallpaperResponse>,
    pub inventory: Vec<InventoryAvailabilityResponse>,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
pub struct ServiceTopologySourceResponse {
    pub room: RoomResponse,
    pub items: Vec<PlacedItemResponse>,
}

#[derive(Clone, Copy, Debug, Serialize, Eq, PartialEq)]
pub struct ServiceTopologyCellResponse {
    pub tile_x: i32,
    pub tile_y: i32,
    pub wall: bool,
    pub item_count: u8,
    pub has_door: bool,
    pub walkable: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Eq, PartialEq)]
pub struct ServiceChairResponse {
    pub instance_id: u64,
    pub tile_x: i32,
    pub tile_y: i32,
    pub rotation: u8,
    pub toilet: bool,
    pub meal_seat: bool,
    pub facing_tile_x: i32,
    pub facing_tile_y: i32,
    pub table_instance_id: Option<u64>,
}

#[derive(Clone, Copy, Debug, Serialize, Eq, PartialEq)]
pub struct ServiceTableResponse {
    pub instance_id: u64,
    pub tile_x: i32,
    pub tile_y: i32,
    pub item_count_on_tile: u8,
    pub has_table_top_order: bool,
    pub free: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Eq, PartialEq)]
pub struct ServiceKitchenResponse {
    pub instance_id: u64,
    pub tile_x: i32,
    pub tile_y: i32,
}

#[derive(Clone, Copy, Debug, Serialize, Eq, PartialEq)]
pub struct ServiceDrinkResponse {
    pub instance_id: u64,
    pub tile_x: i32,
    pub tile_y: i32,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
pub struct ServiceTopologyResponse {
    pub source: ServiceTopologySourceResponse,
    pub cells: Vec<ServiceTopologyCellResponse>,
    pub chairs: Vec<ServiceChairResponse>,
    pub tables: Vec<ServiceTableResponse>,
    pub kitchens: Vec<ServiceKitchenResponse>,
    pub drinks: Vec<ServiceDrinkResponse>,
}

#[derive(Clone, Copy, Debug, Serialize, Eq, PartialEq)]
pub struct ActiveServiceResponse {
    pub service_id: u64,
    pub restaurant_mutation_sequence: u64,
    pub customer_id: u64,
    pub order_id: u64,
    pub chair_instance_id: u64,
    pub table_instance_id: u64,
    pub chef_employee_id: u64,
    pub kitchen_instance_id: u64,
    pub waiter_employee_id: u64,
    pub waiter_tile_x: i32,
    pub waiter_tile_y: i32,
    pub customer_state: &'static str,
    pub order_state: &'static str,
    pub customer_timer_ms: Option<u64>,
    pub order_timer_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, Serialize, Eq, PartialEq)]
pub struct ActiveServiceEnvelopeResponse {
    pub active: Option<ActiveServiceResponse>,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
pub struct PlacementResponse {
    pub outcome: &'static str,
    pub item: PlacedItemResponse,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
pub struct FloorTilePaintResponse {
    pub outcome: &'static str,
    pub tile: FloorTileResponse,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
pub struct WallpaperMutationResponse {
    pub outcome: &'static str,
    pub wallpaper: WallpaperResponse,
}

pub fn handle_load_restaurant<V, S>(
    service: &RestaurantProductService<V, S>,
    context: ProductHttpContext<'_>,
) -> Result<Vec<u8>, PublicProductError>
where
    V: PlatformSessionVerifier,
    S: ProductStateStore,
{
    let session_token = session_token(context.session_token)?;
    let snapshot = service
        .load_restaurant(session_token)
        .map_err(map_service_error)?;
    json_bytes(&layout_response(snapshot))
}

pub fn handle_load_service_topology<V, S>(
    service: &RestaurantProductService<V, S>,
    context: ProductHttpContext<'_>,
) -> Result<Vec<u8>, PublicProductError>
where
    V: PlatformSessionVerifier,
    S: ProductStateStore,
{
    let session_token = session_token(context.session_token)?;
    let (snapshot, topology) = service
        .load_restaurant_with_topology(session_token)
        .map_err(map_service_error)?;
    json_bytes(&service_topology_response(snapshot, topology))
}

pub fn handle_load_active_service<V, S>(
    service: &RestaurantProductService<V, S>,
    context: ProductHttpContext<'_>,
) -> Result<Vec<u8>, PublicProductError>
where
    V: PlatformSessionVerifier,
    S: ProductStateStore,
{
    let session_token = session_token(context.session_token)?;
    let active = service
        .load_active_service(session_token)
        .map_err(map_service_error)?
        .map(active_service_response);
    json_bytes(&ActiveServiceEnvelopeResponse { active })
}

pub fn handle_place_item<V, S>(
    service: &RestaurantProductService<V, S>,
    context: ProductHttpContext<'_>,
    body: &[u8],
) -> Result<Vec<u8>, PublicProductError>
where
    V: PlatformSessionVerifier,
    S: ProductStateStore,
{
    let session_token = session_token(context.session_token)?;
    let mutation_id = mutation_id(context.mutation_id)?;

    if body.is_empty() || body.len() > MAX_BODY_BYTES {
        return Err(PublicProductError::InvalidRequest);
    }

    let dto: PlacementRequestDto =
        serde_json::from_slice(body).map_err(|_| PublicProductError::InvalidRequest)?;

    if dto.rotation > MAX_HISTORICAL_ROTATION_INDEX {
        return Err(PublicProductError::Unprocessable);
    }

    let outcome = service
        .place_item(
            session_token,
            mutation_id,
            PlacementIntent {
                item_id: dto.item_id,
                tile: TilePoint {
                    x: dto.tile_x,
                    y: dto.tile_y,
                },
                rotation: dto.rotation,
            },
        )
        .map_err(map_service_error)?;

    mutation_response(outcome)
}

pub fn handle_paint_floor_tile<V, S>(
    service: &RestaurantProductService<V, S>,
    context: ProductHttpContext<'_>,
    body: &[u8],
) -> Result<Vec<u8>, PublicProductError>
where
    V: PlatformSessionVerifier,
    S: ProductStateStore,
{
    let session_token = session_token(context.session_token)?;
    let mutation_id = mutation_id(context.mutation_id)?;
    if body.is_empty() || body.len() > MAX_BODY_BYTES {
        return Err(PublicProductError::InvalidRequest);
    }

    let dto: FloorTileRequestDto =
        serde_json::from_slice(body).map_err(|_| PublicProductError::InvalidRequest)?;
    let outcome = service
        .paint_floor_tile(
            session_token,
            mutation_id,
            FloorTileIntent {
                item_id: dto.item_id,
                tile: TilePoint {
                    x: dto.tile_x,
                    y: dto.tile_y,
                },
            },
        )
        .map_err(map_service_error)?;

    floor_tile_mutation_response(outcome)
}

pub fn handle_apply_wallpaper<V, S>(
    service: &RestaurantProductService<V, S>,
    context: ProductHttpContext<'_>,
    body: &[u8],
) -> Result<Vec<u8>, PublicProductError>
where
    V: PlatformSessionVerifier,
    S: ProductStateStore,
{
    let session_token = session_token(context.session_token)?;
    let mutation_id = mutation_id(context.mutation_id)?;
    if body.is_empty() || body.len() > MAX_BODY_BYTES {
        return Err(PublicProductError::InvalidRequest);
    }

    let dto: WallpaperRequestDto =
        serde_json::from_slice(body).map_err(|_| PublicProductError::InvalidRequest)?;
    let outcome = service
        .apply_wallpaper(
            session_token,
            mutation_id,
            WallpaperIntent {
                item_id: dto.item_id,
                wall_tile: TilePoint {
                    x: dto.tile_x,
                    y: dto.tile_y,
                },
            },
        )
        .map_err(map_service_error)?;

    wallpaper_mutation_response(outcome)
}

pub fn handle_remove_wallpaper<V, S>(
    service: &RestaurantProductService<V, S>,
    context: ProductHttpContext<'_>,
    rotation: u8,
) -> Result<Vec<u8>, PublicProductError>
where
    V: PlatformSessionVerifier,
    S: ProductStateStore,
{
    let session_token = session_token(context.session_token)?;
    let mutation_id = mutation_id(context.mutation_id)?;
    let orientation =
        WallpaperOrientation::from_rotation(rotation).ok_or(PublicProductError::Unprocessable)?;

    let outcome = service
        .remove_wallpaper(session_token, mutation_id, orientation)
        .map_err(map_service_error)?;

    wallpaper_mutation_response(outcome)
}

pub fn handle_transform_item<V, S>(
    service: &RestaurantProductService<V, S>,
    context: ProductHttpContext<'_>,
    instance_id: u64,
    body: &[u8],
) -> Result<Vec<u8>, PublicProductError>
where
    V: PlatformSessionVerifier,
    S: ProductStateStore,
{
    let session_token = session_token(context.session_token)?;
    let mutation_id = mutation_id(context.mutation_id)?;
    if instance_id == 0 || body.is_empty() || body.len() > MAX_BODY_BYTES {
        return Err(PublicProductError::InvalidRequest);
    }

    let dto: TransformRequestDto =
        serde_json::from_slice(body).map_err(|_| PublicProductError::InvalidRequest)?;
    if dto.rotation > MAX_HISTORICAL_ROTATION_INDEX {
        return Err(PublicProductError::Unprocessable);
    }

    let outcome = service
        .transform_item(
            session_token,
            mutation_id,
            instance_id,
            TilePoint {
                x: dto.tile_x,
                y: dto.tile_y,
            },
            dto.rotation,
        )
        .map_err(map_service_error)?;

    mutation_response(outcome)
}

pub fn handle_remove_item<V, S>(
    service: &RestaurantProductService<V, S>,
    context: ProductHttpContext<'_>,
    instance_id: u64,
) -> Result<Vec<u8>, PublicProductError>
where
    V: PlatformSessionVerifier,
    S: ProductStateStore,
{
    let session_token = session_token(context.session_token)?;
    let mutation_id = mutation_id(context.mutation_id)?;
    if instance_id == 0 {
        return Err(PublicProductError::InvalidRequest);
    }

    let outcome = service
        .remove_item(session_token, mutation_id, instance_id)
        .map_err(map_service_error)?;

    mutation_response(outcome)
}

fn mutation_response(outcome: PlacementMutationOutcome) -> Result<Vec<u8>, PublicProductError> {
    let response = match outcome {
        PlacementMutationOutcome::Applied(item) => PlacementResponse {
            outcome: "applied",
            item: placed_item_response(item),
        },
        PlacementMutationOutcome::Duplicate(item) => PlacementResponse {
            outcome: "duplicate",
            item: placed_item_response(item),
        },
    };
    json_bytes(&response)
}

fn floor_tile_mutation_response(
    outcome: FloorTileMutationOutcome,
) -> Result<Vec<u8>, PublicProductError> {
    let response = match outcome {
        FloorTileMutationOutcome::Applied(tile) => FloorTilePaintResponse {
            outcome: "applied",
            tile: floor_tile_response(tile),
        },
        FloorTileMutationOutcome::Duplicate(tile) => FloorTilePaintResponse {
            outcome: "duplicate",
            tile: floor_tile_response(tile),
        },
    };
    json_bytes(&response)
}

fn wallpaper_mutation_response(
    outcome: WallpaperMutationOutcome,
) -> Result<Vec<u8>, PublicProductError> {
    let response = match outcome {
        WallpaperMutationOutcome::Applied(wallpaper) => WallpaperMutationResponse {
            outcome: "applied",
            wallpaper: wallpaper_response(wallpaper),
        },
        WallpaperMutationOutcome::Duplicate(wallpaper) => WallpaperMutationResponse {
            outcome: "duplicate",
            wallpaper: wallpaper_response(wallpaper),
        },
    };
    json_bytes(&response)
}

fn session_token(value: Option<&str>) -> Result<&str, PublicProductError> {
    let token = value.ok_or(PublicProductError::Unauthenticated)?;
    if token.is_empty()
        || token.len() > MAX_SESSION_TOKEN_BYTES
        || !token.is_ascii()
        || token.bytes().any(|byte| byte.is_ascii_whitespace())
        || token.contains([';', ','])
    {
        return Err(PublicProductError::Unauthenticated);
    }

    Ok(token)
}

fn mutation_id(value: Option<&str>) -> Result<MutationId, PublicProductError> {
    let value = value.ok_or(PublicProductError::InvalidRequest)?;
    if value.is_empty() || value.len() > MAX_MUTATION_ID_BYTES {
        return Err(PublicProductError::InvalidRequest);
    }

    MutationId::new(value.to_owned()).map_err(|_| PublicProductError::InvalidRequest)
}

fn layout_response(snapshot: RestaurantProductSnapshot) -> RestaurantLayoutResponse {
    RestaurantLayoutResponse {
        room: RoomResponse {
            inside_x: snapshot.restaurant.room.inside_x,
            inside_y: snapshot.restaurant.room.inside_y,
            outside_x: snapshot.restaurant.room.outside_x,
            outside_y: snapshot.restaurant.room.outside_y,
        },
        next_instance_id: snapshot.restaurant.next_instance_id,
        items: snapshot
            .restaurant
            .items
            .into_iter()
            .map(placed_item_response)
            .collect(),
        floor_tiles: snapshot
            .floor_tiles
            .into_iter()
            .map(floor_tile_response)
            .collect(),
        wallpapers: snapshot
            .wallpapers
            .into_iter()
            .map(wallpaper_response)
            .collect(),
        inventory: snapshot
            .inventory
            .into_iter()
            .map(inventory_availability_response)
            .collect(),
    }
}

fn service_topology_response(
    snapshot: RestaurantProductSnapshot,
    topology: ServiceLayoutSnapshot,
) -> ServiceTopologyResponse {
    let source = ServiceTopologySourceResponse {
        room: RoomResponse {
            inside_x: snapshot.restaurant.room.inside_x,
            inside_y: snapshot.restaurant.room.inside_y,
            outside_x: snapshot.restaurant.room.outside_x,
            outside_y: snapshot.restaurant.room.outside_y,
        },
        items: snapshot
            .restaurant
            .items
            .iter()
            .copied()
            .map(placed_item_response)
            .collect(),
    };

    let mut cells = Vec::new();
    for y in 0..MAX_NUM_TILES_Y {
        for x in 0..MAX_NUM_TILES_X {
            let tile = TilePoint { x, y };
            if topology.grid.is_tile_out_of_bound(tile) {
                continue;
            }
            let Some(cell) = topology.grid.cell(tile) else {
                continue;
            };
            cells.push(ServiceTopologyCellResponse {
                tile_x: x,
                tile_y: y,
                wall: cell.wall,
                item_count: cell.item_count,
                has_door: cell.has_door,
                walkable: topology.grid.is_walkable(tile),
            });
        }
    }

    let chairs = topology
        .chairs
        .iter()
        .copied()
        .map(|chair| {
            let facing = facing_tile(chair.tile, chair.rotation);
            ServiceChairResponse {
                instance_id: chair.instance_id,
                tile_x: chair.tile.x,
                tile_y: chair.tile.y,
                rotation: chair.rotation,
                toilet: chair.toilet,
                meal_seat: is_meal_seat(chair),
                facing_tile_x: facing.x,
                facing_tile_y: facing.y,
                table_instance_id: table_for_chair(chair, &topology.tables)
                    .map(|table| table.instance_id),
            }
        })
        .collect();

    let tables = topology
        .tables
        .iter()
        .copied()
        .map(|table| ServiceTableResponse {
            instance_id: table.instance_id,
            tile_x: table.tile.x,
            tile_y: table.tile.y,
            item_count_on_tile: table.item_count_on_tile,
            has_table_top_order: table.has_table_top_order,
            free: is_table_free(table),
        })
        .collect();

    let kitchens = topology
        .kitchens
        .iter()
        .copied()
        .map(|kitchen| ServiceKitchenResponse {
            instance_id: kitchen.instance_id,
            tile_x: kitchen.tile.x,
            tile_y: kitchen.tile.y,
        })
        .collect();

    let drinks = topology
        .drinks
        .iter()
        .copied()
        .map(|drink| ServiceDrinkResponse {
            instance_id: drink.instance_id,
            tile_x: drink.tile.x,
            tile_y: drink.tile.y,
        })
        .collect();

    ServiceTopologyResponse {
        source,
        cells,
        chairs,
        tables,
        kitchens,
        drinks,
    }
}

fn inventory_availability_response(item: InventoryAvailability) -> InventoryAvailabilityResponse {
    InventoryAvailabilityResponse {
        item_id: item.item_id,
        owned: item.owned,
        placed: item.placed,
        available: item.available,
    }
}

fn floor_tile_response(tile: PaintedFloorTile) -> FloorTileResponse {
    FloorTileResponse {
        item_id: tile.item_id,
        tile_x: tile.tile.x,
        tile_y: tile.tile.y,
        room_index: tile.room_index,
    }
}

fn active_service_response(record: ActiveServiceRecord) -> ActiveServiceResponse {
    ActiveServiceResponse {
        service_id: record.identity.service_id,
        restaurant_mutation_sequence: record.identity.restaurant_mutation_sequence,
        customer_id: record.identity.customer_id,
        order_id: record.identity.order_id,
        chair_instance_id: record.identity.chair_instance_id,
        table_instance_id: record.identity.table_instance_id,
        chef_employee_id: record.identity.chef_employee_id,
        kitchen_instance_id: record.identity.kitchen_instance_id,
        waiter_employee_id: record.identity.waiter_employee_id,
        waiter_tile_x: record.identity.waiter_tile.x,
        waiter_tile_y: record.identity.waiter_tile.y,
        customer_state: customer_state_name(record.state.customer),
        order_state: order_state_name(record.state.order),
        customer_timer_ms: record.state.customer_timer_ms,
        order_timer_ms: record.state.order_timer_ms,
    }
}

fn customer_state_name(state: CustomerServiceState) -> &'static str {
    match state {
        CustomerServiceState::Admitted => "admitted",
        CustomerServiceState::WalkingToChair => "walking-to-chair",
        CustomerServiceState::Deciding => "deciding",
        CustomerServiceState::Waiting => "waiting",
        CustomerServiceState::WaitingForFood => "waiting-for-food",
        CustomerServiceState::Eating => "eating",
        CustomerServiceState::Paying => "paying",
        CustomerServiceState::Leaving => "leaving",
        CustomerServiceState::Left => "left",
    }
}

fn order_state_name(state: OrderServiceState) -> &'static str {
    match state {
        OrderServiceState::Created => "created",
        OrderServiceState::Queued => "queued",
        OrderServiceState::Cooking => "cooking",
        OrderServiceState::Completed => "completed",
        OrderServiceState::WaiterCollecting => "waiter-collecting",
        OrderServiceState::Serving => "serving",
        OrderServiceState::EmptyPlate => "empty-plate",
        OrderServiceState::Settled => "settled",
    }
}

fn wallpaper_response(wallpaper: AppliedWallpaper) -> WallpaperResponse {
    WallpaperResponse {
        item_id: wallpaper.item_id,
        rotation: wallpaper.orientation.rotation(),
    }
}

fn placed_item_response(item: PlacedItem) -> PlacedItemResponse {
    PlacedItemResponse {
        instance_id: item.instance_id,
        item_id: item.item_id,
        tile_x: item.tile.x,
        tile_y: item.tile.y,
        rotation: item.rotation,
        room_index: item.room_index,
    }
}

fn json_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, PublicProductError> {
    serde_json::to_vec(value).map_err(|_| PublicProductError::Internal)
}

fn map_service_error(error: ProductServiceError) -> PublicProductError {
    match error {
        ProductServiceError::Session(PlatformSessionError::Missing)
        | ProductServiceError::Session(PlatformSessionError::Invalid)
        | ProductServiceError::Session(PlatformSessionError::InvalidSession)
        | ProductServiceError::Session(PlatformSessionError::Expired)
        | ProductServiceError::Session(PlatformSessionError::WrongProduct)
        | ProductServiceError::Session(PlatformSessionError::InvalidSubject) => {
            PublicProductError::Unauthenticated
        }
        ProductServiceError::Session(PlatformSessionError::Unavailable)
        | ProductServiceError::Store(crate::service::ProductStateStoreError::Unavailable) => {
            PublicProductError::Unavailable
        }
        ProductServiceError::Store(crate::service::ProductStateStoreError::Corrupt) => {
            PublicProductError::Internal
        }
        ProductServiceError::Store(crate::service::ProductStateStoreError::Conflict)
        | ProductServiceError::StoreConflict => PublicProductError::Conflict,
        ProductServiceError::SubjectMismatch => PublicProductError::Forbidden,
        ProductServiceError::ItemUnavailable { .. } => PublicProductError::Conflict,
        ProductServiceError::PlayerAuthority(_) => PublicProductError::Conflict,
        ProductServiceError::RestaurantAuthority(
            crate::restaurant::RestaurantAuthorityError::Collision { .. }
            | crate::restaurant::RestaurantAuthorityError::StackLimit { .. },
        ) => PublicProductError::Conflict,
        ProductServiceError::RestaurantAuthority(
            crate::restaurant::RestaurantAuthorityError::CorruptStackOrder { .. },
        ) => PublicProductError::Internal,
        ProductServiceError::RestaurantAuthority(_) => PublicProductError::Unprocessable,
        ProductServiceError::ActiveServiceAuthority(_)
        | ProductServiceError::ServiceLoopAuthority(_)
        | ProductServiceError::ActiveServiceInProgress
        | ProductServiceError::ActiveServiceLayoutLocked
        | ProductServiceError::ActiveServiceNotFound
        | ProductServiceError::ActiveServiceIdMismatch
        | ProductServiceError::ActiveServiceNotComplete
        | ProductServiceError::ServiceTimingAlreadyAnchored
        | ProductServiceError::MutationIdConflict
        | ProductServiceError::WallpaperNotApplied { .. } => PublicProductError::Conflict,
        ProductServiceError::ServiceTimingAuthority(_)
        | ProductServiceError::MealSettlementNotConnected
        | ProductServiceError::RestaurantMutationSequenceExhausted
        | ProductServiceError::FloorMutationSequenceExhausted
        | ProductServiceError::WallpaperMutationSequenceExhausted
        | ProductServiceError::ServiceMutationSequenceExhausted
        | ProductServiceError::ServiceIdExhausted => PublicProductError::Internal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::active_service::ActiveServiceAssignment;
    use crate::domain::{Command, MutationId};
    use crate::placement::{Footprint, PlacementFlags, RoomDimensions};
    use crate::platform::{
        AnewSubject, PlatformSessionError, PlatformSessionVerifier, ProductSessionId,
        VerifiedProductSession,
    };
    use crate::restaurant::{ItemPlacementDefinition, PlacementCatalog};
    use crate::service::{InMemoryProductStateStore, RestaurantProductService};

    #[derive(Clone, Copy)]
    struct FakeVerifier {
        subject: AnewSubject,
        session_id: ProductSessionId,
    }

    impl PlatformSessionVerifier for FakeVerifier {
        fn verify_product_session(
            &self,
            session_token: &str,
        ) -> Result<VerifiedProductSession, PlatformSessionError> {
            if session_token != "session" {
                return Err(PlatformSessionError::Invalid);
            }
            Ok(VerifiedProductSession {
                subject: self.subject,
                session_id: self.session_id,
            })
        }
    }

    fn service_with_rotation_count(
        rotation_count: u8,
    ) -> RestaurantProductService<FakeVerifier, InMemoryProductStateStore> {
        let catalog = PlacementCatalog::new([ItemPlacementDefinition {
            item_id: 10,
            footprint: Footprint {
                size_x: 2,
                size_y: 1,
            },
            rotation_count,
            flags: PlacementFlags::default(),
        }])
        .unwrap();

        RestaurantProductService::new(
            FakeVerifier {
                subject: AnewSubject::from_verified_platform_bytes([7; 16]).unwrap(),
                session_id: ProductSessionId::from_verified_platform_bytes([9; 16]).unwrap(),
            },
            InMemoryProductStateStore::default(),
            catalog,
            RoomDimensions {
                inside_x: 8,
                inside_y: 8,
                outside_x: 0,
                outside_y: 0,
            },
        )
    }

    fn service() -> RestaurantProductService<FakeVerifier, InMemoryProductStateStore> {
        service_with_rotation_count(4)
    }

    fn wallpaper_service() -> RestaurantProductService<FakeVerifier, InMemoryProductStateStore> {
        let catalog = PlacementCatalog::new([ItemPlacementDefinition {
            item_id: 3_060_000,
            footprint: Footprint {
                size_x: 1,
                size_y: 1,
            },
            rotation_count: 2,
            flags: PlacementFlags {
                wallpaper_item: true,
                ..PlacementFlags::default()
            },
        }])
        .unwrap();

        RestaurantProductService::new(
            FakeVerifier {
                subject: AnewSubject::from_verified_platform_bytes([7; 16]).unwrap(),
                session_id: ProductSessionId::from_verified_platform_bytes([9; 16]).unwrap(),
            },
            InMemoryProductStateStore::default(),
            catalog,
            RoomDimensions {
                inside_x: 8,
                inside_y: 8,
                outside_x: 0,
                outside_y: 0,
            },
        )
    }

    fn topology_service() -> RestaurantProductService<FakeVerifier, InMemoryProductStateStore> {
        let catalog = PlacementCatalog::from_trusted_tsv(concat!(
            "ANEWON_RC_PLACEMENT_CATALOG_V4\n",
            "item_id\tsize_x\tsize_y\trotation_count\twall_item\twall_decoration_item\twallpaper_item\toutdoor\tfloor_tile_item\tsurface\tstackable\tdoor_item\tchair_item\ttable_item\tkitchen\tdrink\ttoilet\toccupied_cells\n",
            "11\t1\t1\t4\t0\t0\t0\t0\t0\t0\t0\t0\t1\t0\t0\t0\t0\t-\n",
            "12\t1\t1\t4\t0\t0\t0\t0\t0\t0\t0\t0\t0\t1\t0\t0\t0\t-\n",
            "13\t2\t1\t4\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0\t1\t0\t0\t0,0+1,0/0,0+0,1/0,0+-1,0/0,0+0,-1\n",
        ))
        .unwrap();

        RestaurantProductService::new(
            FakeVerifier {
                subject: AnewSubject::from_verified_platform_bytes([7; 16]).unwrap(),
                session_id: ProductSessionId::from_verified_platform_bytes([9; 16]).unwrap(),
            },
            InMemoryProductStateStore::default(),
            catalog,
            RoomDimensions {
                inside_x: 8,
                inside_y: 8,
                outside_x: 0,
                outside_y: 0,
            },
        )
    }

    fn context<'a>(
        session_token: Option<&'a str>,
        mutation_id: Option<&'a str>,
    ) -> ProductHttpContext<'a> {
        ProductHttpContext {
            session_token,
            mutation_id,
        }
    }

    #[test]
    fn load_requires_bounded_opaque_session_token() {
        let service = service();

        assert_eq!(
            handle_load_restaurant(&service, context(None, None)),
            Err(PublicProductError::Unauthenticated)
        );
        assert_eq!(
            handle_load_restaurant(&service, context(Some("session token"), None)),
            Err(PublicProductError::Unauthenticated)
        );
        assert!(handle_load_restaurant(&service, context(Some("session"), None)).is_ok());
    }

    #[test]
    fn load_projects_authoritative_inventory_availability() {
        let service = service();
        service
            .apply_player_command(
                "session",
                MutationId::new("grant-1".to_owned()).unwrap(),
                Command::GrantInventory {
                    item_id: 10,
                    quantity: 2,
                },
            )
            .unwrap();

        let body = handle_load_restaurant(&service, context(Some("session"), None)).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

        assert_eq!(json["inventory"].as_array().unwrap().len(), 1);
        assert_eq!(json["inventory"][0]["item_id"], 10);
        assert_eq!(json["inventory"][0]["owned"], 2);
        assert_eq!(json["inventory"][0]["placed"], 0);
        assert_eq!(json["inventory"][0]["available"], 2);
    }

    #[test]
    fn topology_projects_service_roles_walkability_and_exact_source_layout() {
        let service = topology_service();
        for item_id in [11_u32, 12, 13] {
            service
                .apply_player_command(
                    "session",
                    MutationId::new(format!("grant-{item_id}")).unwrap(),
                    Command::GrantInventory {
                        item_id,
                        quantity: 1,
                    },
                )
                .unwrap();
        }

        for (mutation_id, item_id, tile, rotation) in [
            ("chair", 11_u32, TilePoint { x: 2, y: 2 }, 0_u8),
            ("table", 12_u32, TilePoint { x: 3, y: 2 }, 0_u8),
            ("kitchen", 13_u32, TilePoint { x: 6, y: 4 }, 2_u8),
        ] {
            service
                .place_item(
                    "session",
                    MutationId::new(mutation_id.to_owned()).unwrap(),
                    PlacementIntent {
                        item_id,
                        tile,
                        rotation,
                    },
                )
                .unwrap();
        }

        let body = handle_load_service_topology(&service, context(Some("session"), None)).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

        assert_eq!(json["source"]["items"].as_array().unwrap().len(), 3);
        assert_eq!(json["chairs"].as_array().unwrap().len(), 1);
        assert_eq!(json["chairs"][0]["facing_tile_x"], 3);
        assert_eq!(json["chairs"][0]["facing_tile_y"], 2);
        assert_eq!(json["chairs"][0]["table_instance_id"], 2);
        assert_eq!(json["chairs"][0]["meal_seat"], true);
        assert_eq!(json["tables"][0]["free"], true);
        assert_eq!(json["kitchens"].as_array().unwrap().len(), 1);

        let kitchen_cells = json["cells"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|cell| cell["tile_y"] == 4 && (cell["tile_x"] == 5 || cell["tile_x"] == 6))
            .collect::<Vec<_>>();
        assert_eq!(kitchen_cells.len(), 2);
        assert!(kitchen_cells.iter().all(|cell| cell["item_count"] == 1));
        assert!(kitchen_cells.iter().all(|cell| cell["walkable"] == false));
    }

    #[test]
    fn active_service_projection_is_read_only_and_projects_authoritative_state() {
        let service = topology_service();
        for item_id in [11_u32, 12, 13] {
            service
                .apply_player_command(
                    "session",
                    MutationId::new(format!("service-grant-{item_id}")).unwrap(),
                    Command::GrantInventory {
                        item_id,
                        quantity: 1,
                    },
                )
                .unwrap();
        }
        for (mutation_id, item_id, tile) in [
            ("service-chair", 11_u32, TilePoint { x: 2, y: 2 }),
            ("service-table", 12_u32, TilePoint { x: 3, y: 2 }),
            ("service-kitchen", 13_u32, TilePoint { x: 6, y: 4 }),
        ] {
            service
                .place_item(
                    "session",
                    MutationId::new(mutation_id.to_owned()).unwrap(),
                    PlacementIntent {
                        item_id,
                        tile,
                        rotation: 0,
                    },
                )
                .unwrap();
        }

        service
            .start_active_service(
                "session",
                MutationId::new("service-start-http".to_owned()).unwrap(),
                ActiveServiceAssignment {
                    chair_instance_id: 1,
                    table_instance_id: 2,
                    chef_employee_id: 101,
                    kitchen_instance_id: 3,
                    waiter_employee_id: 201,
                    waiter_tile: TilePoint { x: 4, y: 4 },
                },
            )
            .unwrap();

        let body = handle_load_active_service(&service, context(Some("session"), None)).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

        assert_eq!(json["active"]["service_id"], 1);
        assert_eq!(json["active"]["restaurant_mutation_sequence"], 3);
        assert_eq!(json["active"]["chair_instance_id"], 1);
        assert_eq!(json["active"]["table_instance_id"], 2);
        assert_eq!(json["active"]["kitchen_instance_id"], 3);
        assert_eq!(json["active"]["waiter_tile_x"], 4);
        assert_eq!(json["active"]["waiter_tile_y"], 4);
        assert_eq!(json["active"]["customer_state"], "admitted");
        assert_eq!(json["active"]["order_state"], "created");
        assert!(json["active"]["customer_timer_ms"].is_null());
        assert!(json["active"]["order_timer_ms"].is_null());

        let empty = topology_service();
        let empty_body =
            handle_load_active_service(&empty, context(Some("session"), None)).unwrap();
        let empty_json: serde_json::Value = serde_json::from_slice(&empty_body).unwrap();
        assert!(empty_json["active"].is_null());
    }

    #[test]
    fn placement_rejects_unknown_json_fields_and_missing_mutation_id() {
        let service = service();

        assert_eq!(
            handle_place_item(
                &service,
                context(Some("session"), Some("p-1")),
                br#"{"item_id":10,"tile_x":2,"tile_y":2,"rotation":0,"extra":true}"#,
            ),
            Err(PublicProductError::InvalidRequest)
        );

        assert_eq!(
            handle_place_item(
                &service,
                context(Some("session"), None),
                br#"{"item_id":10,"tile_x":2,"tile_y":2,"rotation":0}"#,
            ),
            Err(PublicProductError::InvalidRequest)
        );
    }

    #[test]
    fn placement_transport_accepts_recovered_sixteen_frame_rotation_range() {
        let service = service_with_rotation_count(16);
        service
            .apply_player_command(
                "session",
                MutationId::new("grant-rotation-15".to_owned()).unwrap(),
                Command::GrantInventory {
                    item_id: 10,
                    quantity: 1,
                },
            )
            .unwrap();

        let body = handle_place_item(
            &service,
            context(Some("session"), Some("place-rotation-15")),
            br#"{"item_id":10,"tile_x":2,"tile_y":2,"rotation":15}"#,
        )
        .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["item"]["rotation"], 15);

        assert_eq!(
            handle_place_item(
                &service,
                context(Some("session"), Some("place-rotation-16")),
                br#"{"item_id":10,"tile_x":5,"tile_y":2,"rotation":16}"#,
            ),
            Err(PublicProductError::Unprocessable)
        );
    }

    #[test]
    fn placement_requires_owned_item_then_returns_json() {
        let service = service();
        service
            .apply_player_command(
                "session",
                MutationId::new("grant-1".to_owned()).unwrap(),
                Command::GrantInventory {
                    item_id: 10,
                    quantity: 1,
                },
            )
            .unwrap();

        let body = handle_place_item(
            &service,
            context(Some("session"), Some("place-1")),
            br#"{"item_id":10,"tile_x":2,"tile_y":2,"rotation":0}"#,
        )
        .unwrap();

        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["outcome"], "applied");
        assert_eq!(json["item"]["item_id"], 10);
        assert_eq!(json["item"]["instance_id"], 1);
    }

    #[test]
    fn duplicate_http_mutation_is_projected_as_duplicate() {
        let service = service();
        service
            .apply_player_command(
                "session",
                MutationId::new("grant-1".to_owned()).unwrap(),
                Command::GrantInventory {
                    item_id: 10,
                    quantity: 1,
                },
            )
            .unwrap();

        let request = br#"{"item_id":10,"tile_x":2,"tile_y":2,"rotation":0}"#;
        handle_place_item(&service, context(Some("session"), Some("place-1")), request).unwrap();
        let duplicate =
            handle_place_item(&service, context(Some("session"), Some("place-1")), request)
                .unwrap();

        let json: serde_json::Value = serde_json::from_slice(&duplicate).unwrap();
        assert_eq!(json["outcome"], "duplicate");
        assert_eq!(json["item"]["instance_id"], 1);
    }

    #[test]
    fn wallpaper_transport_derives_orientation_and_is_idempotent() {
        let service = wallpaper_service();
        service
            .apply_player_command(
                "session",
                MutationId::new("grant-wallpaper".to_owned()).unwrap(),
                Command::GrantInventory {
                    item_id: 3_060_000,
                    quantity: 1,
                },
            )
            .unwrap();

        let applied = handle_apply_wallpaper(
            &service,
            context(Some("session"), Some("wallpaper-left")),
            br#"{"item_id":3060000,"tile_x":0,"tile_y":2}"#,
        )
        .unwrap();
        let duplicate = handle_apply_wallpaper(
            &service,
            context(Some("session"), Some("wallpaper-left")),
            br#"{"item_id":3060000,"tile_x":0,"tile_y":6}"#,
        )
        .unwrap();

        let applied_json: serde_json::Value = serde_json::from_slice(&applied).unwrap();
        let duplicate_json: serde_json::Value = serde_json::from_slice(&duplicate).unwrap();
        assert_eq!(applied_json["outcome"], "applied");
        assert_eq!(applied_json["wallpaper"]["item_id"], 3_060_000);
        assert_eq!(applied_json["wallpaper"]["rotation"], 0);
        assert_eq!(duplicate_json["outcome"], "duplicate");

        let layout = handle_load_restaurant(&service, context(Some("session"), None)).unwrap();
        let layout_json: serde_json::Value = serde_json::from_slice(&layout).unwrap();
        assert_eq!(layout_json["wallpapers"].as_array().unwrap().len(), 1);
        assert_eq!(layout_json["inventory"][0]["placed"], 1);
        assert_eq!(layout_json["inventory"][0]["available"], 0);

        let removed = handle_remove_wallpaper(
            &service,
            context(Some("session"), Some("wallpaper-remove-left")),
            0,
        )
        .unwrap();
        let removed_duplicate = handle_remove_wallpaper(
            &service,
            context(Some("session"), Some("wallpaper-remove-left")),
            0,
        )
        .unwrap();
        let removed_json: serde_json::Value = serde_json::from_slice(&removed).unwrap();
        let removed_duplicate_json: serde_json::Value =
            serde_json::from_slice(&removed_duplicate).unwrap();
        assert_eq!(removed_json["outcome"], "applied");
        assert_eq!(removed_duplicate_json["outcome"], "duplicate");

        assert_eq!(
            handle_remove_wallpaper(
                &service,
                context(Some("session"), Some("wallpaper-remove-invalid")),
                2,
            ),
            Err(PublicProductError::Unprocessable)
        );

        let after = handle_load_restaurant(&service, context(Some("session"), None)).unwrap();
        let after_json: serde_json::Value = serde_json::from_slice(&after).unwrap();
        assert_eq!(after_json["wallpapers"].as_array().unwrap().len(), 0);
        assert_eq!(after_json["inventory"][0]["placed"], 0);
        assert_eq!(after_json["inventory"][0]["available"], 1);
    }

    #[test]
    fn transform_and_remove_transport_are_idempotent() {
        let service = service();
        service
            .apply_player_command(
                "session",
                MutationId::new("grant-edit".to_owned()).unwrap(),
                Command::GrantInventory {
                    item_id: 10,
                    quantity: 1,
                },
            )
            .unwrap();

        handle_place_item(
            &service,
            context(Some("session"), Some("place-edit")),
            br#"{"item_id":10,"tile_x":2,"tile_y":2,"rotation":0}"#,
        )
        .unwrap();

        let transformed = handle_transform_item(
            &service,
            context(Some("session"), Some("transform-edit")),
            1,
            br#"{"tile_x":4,"tile_y":3,"rotation":1}"#,
        )
        .unwrap();
        let transformed_duplicate = handle_transform_item(
            &service,
            context(Some("session"), Some("transform-edit")),
            1,
            br#"{"tile_x":4,"tile_y":3,"rotation":1}"#,
        )
        .unwrap();

        let transformed_json: serde_json::Value = serde_json::from_slice(&transformed).unwrap();
        let duplicate_json: serde_json::Value =
            serde_json::from_slice(&transformed_duplicate).unwrap();
        assert_eq!(transformed_json["outcome"], "applied");
        assert_eq!(transformed_json["item"]["tile_x"], 4);
        assert_eq!(transformed_json["item"]["tile_y"], 3);
        assert_eq!(transformed_json["item"]["rotation"], 1);
        assert_eq!(duplicate_json["outcome"], "duplicate");

        let removed =
            handle_remove_item(&service, context(Some("session"), Some("remove-edit")), 1).unwrap();
        let removed_duplicate =
            handle_remove_item(&service, context(Some("session"), Some("remove-edit")), 1).unwrap();

        let removed_json: serde_json::Value = serde_json::from_slice(&removed).unwrap();
        let removed_duplicate_json: serde_json::Value =
            serde_json::from_slice(&removed_duplicate).unwrap();
        assert_eq!(removed_json["outcome"], "applied");
        assert_eq!(removed_json["item"]["instance_id"], 1);
        assert_eq!(removed_duplicate_json["outcome"], "duplicate");

        let layout = handle_load_restaurant(&service, context(Some("session"), None)).unwrap();
        let layout_json: serde_json::Value = serde_json::from_slice(&layout).unwrap();
        assert_eq!(layout_json["items"].as_array().unwrap().len(), 0);
        assert_eq!(layout_json["inventory"][0]["available"], 1);
    }

    #[test]
    fn transform_and_remove_reject_invalid_instance_or_payload() {
        let service = service();

        assert_eq!(
            handle_transform_item(
                &service,
                context(Some("session"), Some("transform-invalid")),
                0,
                br#"{"tile_x":2,"tile_y":2,"rotation":0}"#,
            ),
            Err(PublicProductError::InvalidRequest)
        );
        assert_eq!(
            handle_transform_item(
                &service,
                context(Some("session"), Some("transform-invalid-2")),
                1,
                br#"{"tile_x":2,"tile_y":2,"rotation":0,"extra":true}"#,
            ),
            Err(PublicProductError::InvalidRequest)
        );
        assert_eq!(
            handle_remove_item(
                &service,
                context(Some("session"), Some("remove-invalid")),
                0,
            ),
            Err(PublicProductError::InvalidRequest)
        );
    }

    #[test]
    fn public_error_mapping_does_not_leak_authority_details() {
        assert_eq!(PublicProductError::Unauthenticated.status_code(), 401);
        assert_eq!(PublicProductError::Conflict.status_code(), 409);
        assert_eq!(PublicProductError::Unprocessable.code(), "UNPROCESSABLE");
        assert_eq!(
            map_service_error(ProductServiceError::MutationIdConflict),
            PublicProductError::Conflict
        );
        assert_eq!(
            map_service_error(ProductServiceError::RestaurantMutationSequenceExhausted),
            PublicProductError::Internal
        );
    }
}
