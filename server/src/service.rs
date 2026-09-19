use crate::active_service::{
    ActiveServiceAssignment, ActiveServiceError, ActiveServiceIdentity, ActiveServiceRecord,
};
use crate::domain::{
    AuthorityError, Command, MutationId, MutationOutcome, PlayerPersistenceSnapshot, PlayerState,
};
use crate::gameplay::{
    CustomerServiceState, OrderServiceState, ServiceLoopError, ServiceLoopEvent, ServiceLoopState,
};
use crate::placement::{RoomDimensions, TilePoint};
use crate::platform::{
    AnewSubject, PlatformSessionError, PlatformSessionVerifier, VerifiedProductSession,
};
use crate::restaurant::{
    AppliedWallpaper, FloorTileIntent, PaintedFloorTile, PlacedItem, PlacementCatalog,
    PlacementIntent, RestaurantAuthorityError, RestaurantSnapshot, RestaurantState,
    WallpaperIntent, WallpaperOrientation, validate_floor_tile_intent, validate_wallpaper_intent,
};
use crate::service_clock::{
    ServiceDeadlines, ServiceTimeSource, ServiceTimingError, SystemServiceTimeSource,
    due_service_event, validate_service_deadlines,
};
use crate::service_path::{
    ServicePathError, ServicePathKind, ServicePathPlan, plan_customer_path_to_chair,
    validate_customer_path_to_chair_plan,
};
use crate::topology::{ServiceLayoutSnapshot, derive_service_layout};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

const PRODUCT_PERSISTENCE_SCHEMA_VERSION: u8 = 7;
const TIMED_SERVICE_PERSISTENCE_SCHEMA_VERSION: u8 = 6;
const ACTIVE_SERVICE_PERSISTENCE_SCHEMA_VERSION: u8 = 5;
const WALLPAPER_PERSISTENCE_SCHEMA_VERSION: u8 = 4;
const FLOOR_TILE_PERSISTENCE_SCHEMA_VERSION: u8 = 3;
const JOURNALED_OBJECT_PERSISTENCE_SCHEMA_VERSION: u8 = 2;
const LEGACY_PRODUCT_PERSISTENCE_SCHEMA_VERSION: u8 = 1;
const MAX_STORE_RETRIES: usize = 3;

fn timed_event_key(event: ServiceLoopEvent) -> Option<&'static str> {
    match event {
        ServiceLoopEvent::DecisionElapsed => Some("decision"),
        ServiceLoopEvent::CookElapsed => Some("cook"),
        ServiceLoopEvent::WaiterActionElapsed => Some("waiter"),
        ServiceLoopEvent::EatingElapsed => Some("eating"),
        ServiceLoopEvent::PayingElapsed => Some("paying"),
        _ => None,
    }
}

fn internal_service_mutation_id(
    kind: &str,
    service_id: u64,
    effective_at_ms: u64,
    event: Option<ServiceLoopEvent>,
) -> Result<MutationId, ProductServiceError> {
    let event_key = match event {
        Some(event) => timed_event_key(event)
            .ok_or(ProductServiceError::Store(ProductStateStoreError::Corrupt))?,
        None => "none",
    };
    MutationId::new_internal(format!(
        "__anewon_internal__:service:{kind}:{service_id}:{effective_at_ms}:{event_key}"
    ))
    .map_err(|_| ProductServiceError::Store(ProductStateStoreError::Corrupt))
}

fn internal_path_mutation_id(
    kind: &str,
    service_id: u64,
    effective_at_ms: u64,
) -> Result<MutationId, ProductServiceError> {
    MutationId::new_internal(format!(
        "__anewon_internal__:service:path:{kind}:{service_id}:{effective_at_ms}"
    ))
    .map_err(|_| ProductServiceError::Store(ProductStateStoreError::Corrupt))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlacementMutationOutcome {
    Applied(PlacedItem),
    Duplicate(PlacedItem),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FloorTileMutationOutcome {
    Applied(PaintedFloorTile),
    Duplicate(PaintedFloorTile),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WallpaperMutationOutcome {
    Applied(AppliedWallpaper),
    Duplicate(AppliedWallpaper),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActiveServiceMutationOutcome {
    Applied(Option<ActiveServiceRecord>),
    Duplicate(Option<ActiveServiceRecord>),
}

impl ActiveServiceMutationOutcome {
    fn record(self) -> Option<ActiveServiceRecord> {
        match self {
            Self::Applied(record) | Self::Duplicate(record) => record,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ServiceMutationOperation {
    Start {
        restaurant_mutation_sequence: u64,
        assignment: ActiveServiceAssignment,
        effective_at_ms: Option<u64>,
    },
    AnchorTiming {
        service_id: u64,
        effective_at_ms: u64,
    },
    Transition {
        service_id: u64,
        event: ServiceLoopEvent,
        effective_at_ms: Option<u64>,
    },
    StartCustomerChairPath {
        service_id: u64,
        start_tile: TilePoint,
        effective_at_ms: u64,
    },
    CompleteCustomerChairPath {
        service_id: u64,
        effective_at_ms: u64,
    },
    Complete {
        service_id: u64,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ServiceMutationRecord {
    sequence: u64,
    operation: ServiceMutationOperation,
    result: Option<ActiveServiceRecord>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WallpaperMutationOperation {
    Apply,
    Remove,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct WallpaperMutationRecord {
    sequence: u64,
    operation: WallpaperMutationOperation,
    wallpaper: AppliedWallpaper,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct FloorTileKey {
    room_index: u8,
    tile_x: i32,
    tile_y: i32,
}

impl From<PaintedFloorTile> for FloorTileKey {
    fn from(value: PaintedFloorTile) -> Self {
        Self {
            room_index: value.room_index,
            tile_x: value.tile.x,
            tile_y: value.tile.y,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FloorTileMutationRecord {
    sequence: u64,
    tile: PaintedFloorTile,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RestaurantMutationOperation {
    Place,
    Transform,
    Remove,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct RestaurantMutationRecord {
    sequence: u64,
    operation: RestaurantMutationOperation,
    item: PlacedItem,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InventoryAvailability {
    pub item_id: u32,
    pub owned: u32,
    pub placed: u32,
    pub available: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RestaurantProductSnapshot {
    pub restaurant: RestaurantSnapshot,
    pub floor_tiles: Vec<PaintedFloorTile>,
    pub wallpapers: Vec<AppliedWallpaper>,
    pub inventory: Vec<InventoryAvailability>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ActiveServiceReadSnapshot {
    pub server_now_ms: u64,
    pub active: Option<ActiveServiceRecord>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductAggregate {
    player: PlayerState,
    restaurant: RestaurantState,
    restaurant_mutations: BTreeMap<MutationId, RestaurantMutationRecord>,
    next_restaurant_mutation_sequence: u64,
    floor_tiles: BTreeMap<FloorTileKey, PaintedFloorTile>,
    floor_mutations: BTreeMap<MutationId, FloorTileMutationRecord>,
    next_floor_mutation_sequence: u64,
    wallpapers: BTreeMap<WallpaperOrientation, AppliedWallpaper>,
    wallpaper_mutations: BTreeMap<MutationId, WallpaperMutationRecord>,
    next_wallpaper_mutation_sequence: u64,
    active_service: Option<ActiveServiceRecord>,
    service_mutations: BTreeMap<MutationId, ServiceMutationRecord>,
    next_service_mutation_sequence: u64,
    next_service_id: u64,
}

#[derive(Clone, Debug, Deserialize)]
struct PersistedSchemaHeader {
    schema_version: u8,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedAggregate {
    schema_version: u8,
    player: PlayerPersistenceSnapshot,
    restaurant: PersistedRestaurant,
    next_restaurant_mutation_sequence: u64,
    restaurant_mutations: Vec<PersistedRestaurantMutation>,
    #[serde(default)]
    next_floor_mutation_sequence: u64,
    #[serde(default)]
    floor_mutations: Vec<PersistedFloorTileMutation>,
    #[serde(default)]
    next_wallpaper_mutation_sequence: u64,
    #[serde(default)]
    wallpaper_mutations: Vec<PersistedWallpaperMutation>,
    #[serde(default)]
    active_service: Option<PersistedActiveService>,
    #[serde(default)]
    service_mutations: Vec<PersistedServiceMutation>,
    #[serde(default)]
    next_service_mutation_sequence: u64,
    #[serde(default)]
    next_service_id: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyPersistedAggregate {
    schema_version: u8,
    player: PlayerPersistenceSnapshot,
    restaurant: PersistedRestaurant,
    placement_mutations: Vec<PersistedPlacementMutation>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedActiveServiceAssignment {
    chair_instance_id: u64,
    table_instance_id: u64,
    chef_employee_id: u64,
    kitchen_instance_id: u64,
    waiter_employee_id: u64,
    waiter_tile_x: i32,
    waiter_tile_y: i32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedActiveService {
    service_id: u64,
    restaurant_mutation_sequence: u64,
    customer_id: u64,
    order_id: u64,
    chair_instance_id: u64,
    table_instance_id: u64,
    chef_employee_id: u64,
    kitchen_instance_id: u64,
    waiter_employee_id: u64,
    waiter_tile_x: i32,
    waiter_tile_y: i32,
    state: ServiceLoopState,
    #[serde(default)]
    timing_anchored: bool,
    #[serde(default)]
    customer_deadline_at_ms: Option<u64>,
    #[serde(default)]
    order_deadline_at_ms: Option<u64>,
    #[serde(default)]
    active_path: Option<ServicePathPlan>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PersistedServiceMutationOperation {
    Start {
        restaurant_mutation_sequence: u64,
        assignment: PersistedActiveServiceAssignment,
        #[serde(default)]
        effective_at_ms: Option<u64>,
    },
    AnchorTiming {
        service_id: u64,
        effective_at_ms: u64,
    },
    Transition {
        service_id: u64,
        event: ServiceLoopEvent,
        #[serde(default)]
        effective_at_ms: Option<u64>,
    },
    StartCustomerChairPath {
        service_id: u64,
        start_tile_x: i32,
        start_tile_y: i32,
        effective_at_ms: u64,
    },
    CompleteCustomerChairPath {
        service_id: u64,
        effective_at_ms: u64,
    },
    Complete {
        service_id: u64,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedServiceMutation {
    mutation_id: String,
    sequence: u64,
    operation: PersistedServiceMutationOperation,
    result: Option<PersistedActiveService>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedRestaurant {
    room: PersistedRoom,
    next_instance_id: u64,
    items: Vec<PersistedPlacedItem>,
    #[serde(default)]
    floor_tiles: Vec<PersistedFloorTile>,
    #[serde(default)]
    wallpapers: Vec<PersistedWallpaper>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedRoom {
    inside_x: u32,
    inside_y: u32,
    outside_x: u32,
    outside_y: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedPlacedItem {
    instance_id: u64,
    item_id: u32,
    tile_x: i32,
    tile_y: i32,
    rotation: u8,
    room_index: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedFloorTile {
    item_id: u32,
    tile_x: i32,
    tile_y: i32,
    room_index: u8,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedFloorTileMutation {
    mutation_id: String,
    sequence: u64,
    tile: PersistedFloorTile,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedWallpaper {
    item_id: u32,
    rotation: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PersistedWallpaperMutationOperation {
    Apply,
    Remove,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedWallpaperMutation {
    mutation_id: String,
    sequence: u64,
    operation: PersistedWallpaperMutationOperation,
    wallpaper: PersistedWallpaper,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PersistedRestaurantMutationOperation {
    Place,
    Transform,
    Remove,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedRestaurantMutation {
    mutation_id: String,
    sequence: u64,
    operation: PersistedRestaurantMutationOperation,
    item: PersistedPlacedItem,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedPlacementMutation {
    mutation_id: String,
    item: PersistedPlacedItem,
}

impl From<RestaurantMutationOperation> for PersistedRestaurantMutationOperation {
    fn from(value: RestaurantMutationOperation) -> Self {
        match value {
            RestaurantMutationOperation::Place => Self::Place,
            RestaurantMutationOperation::Transform => Self::Transform,
            RestaurantMutationOperation::Remove => Self::Remove,
        }
    }
}

impl From<PersistedRestaurantMutationOperation> for RestaurantMutationOperation {
    fn from(value: PersistedRestaurantMutationOperation) -> Self {
        match value {
            PersistedRestaurantMutationOperation::Place => Self::Place,
            PersistedRestaurantMutationOperation::Transform => Self::Transform,
            PersistedRestaurantMutationOperation::Remove => Self::Remove,
        }
    }
}

impl From<WallpaperMutationOperation> for PersistedWallpaperMutationOperation {
    fn from(value: WallpaperMutationOperation) -> Self {
        match value {
            WallpaperMutationOperation::Apply => Self::Apply,
            WallpaperMutationOperation::Remove => Self::Remove,
        }
    }
}

impl From<PersistedWallpaperMutationOperation> for WallpaperMutationOperation {
    fn from(value: PersistedWallpaperMutationOperation) -> Self {
        match value {
            PersistedWallpaperMutationOperation::Apply => Self::Apply,
            PersistedWallpaperMutationOperation::Remove => Self::Remove,
        }
    }
}

impl From<ActiveServiceAssignment> for PersistedActiveServiceAssignment {
    fn from(value: ActiveServiceAssignment) -> Self {
        Self {
            chair_instance_id: value.chair_instance_id,
            table_instance_id: value.table_instance_id,
            chef_employee_id: value.chef_employee_id,
            kitchen_instance_id: value.kitchen_instance_id,
            waiter_employee_id: value.waiter_employee_id,
            waiter_tile_x: value.waiter_tile.x,
            waiter_tile_y: value.waiter_tile.y,
        }
    }
}

impl From<PersistedActiveServiceAssignment> for ActiveServiceAssignment {
    fn from(value: PersistedActiveServiceAssignment) -> Self {
        Self {
            chair_instance_id: value.chair_instance_id,
            table_instance_id: value.table_instance_id,
            chef_employee_id: value.chef_employee_id,
            kitchen_instance_id: value.kitchen_instance_id,
            waiter_employee_id: value.waiter_employee_id,
            waiter_tile: TilePoint {
                x: value.waiter_tile_x,
                y: value.waiter_tile_y,
            },
        }
    }
}

impl From<ActiveServiceRecord> for PersistedActiveService {
    fn from(value: ActiveServiceRecord) -> Self {
        Self {
            service_id: value.identity.service_id,
            restaurant_mutation_sequence: value.identity.restaurant_mutation_sequence,
            customer_id: value.identity.customer_id,
            order_id: value.identity.order_id,
            chair_instance_id: value.identity.chair_instance_id,
            table_instance_id: value.identity.table_instance_id,
            chef_employee_id: value.identity.chef_employee_id,
            kitchen_instance_id: value.identity.kitchen_instance_id,
            waiter_employee_id: value.identity.waiter_employee_id,
            waiter_tile_x: value.identity.waiter_tile.x,
            waiter_tile_y: value.identity.waiter_tile.y,
            state: value.state,
            timing_anchored: value.timing_anchored,
            customer_deadline_at_ms: value.deadlines.customer_deadline_at_ms,
            order_deadline_at_ms: value.deadlines.order_deadline_at_ms,
            active_path: value.active_path,
        }
    }
}

impl TryFrom<PersistedActiveService> for ActiveServiceRecord {
    type Error = ProductStateStoreError;

    fn try_from(value: PersistedActiveService) -> Result<Self, Self::Error> {
        if value.service_id == 0
            || value.customer_id != value.service_id
            || value.order_id != value.service_id
            || value.chair_instance_id == 0
            || value.table_instance_id == 0
            || value.chef_employee_id == 0
            || value.kitchen_instance_id == 0
            || value.waiter_employee_id == 0
        {
            return Err(ProductStateStoreError::Corrupt);
        }
        let deadlines = ServiceDeadlines {
            customer_deadline_at_ms: value.customer_deadline_at_ms,
            order_deadline_at_ms: value.order_deadline_at_ms,
        };
        if value.timing_anchored {
            validate_service_deadlines(value.state, deadlines)
                .map_err(|_| ProductStateStoreError::Corrupt)?;
        } else if deadlines != ServiceDeadlines::default() {
            return Err(ProductStateStoreError::Corrupt);
        }
        if value
            .active_path
            .is_some_and(|path| path.completes_at_ms < path.started_at_ms)
        {
            return Err(ProductStateStoreError::Corrupt);
        }

        Ok(Self {
            identity: ActiveServiceIdentity {
                service_id: value.service_id,
                restaurant_mutation_sequence: value.restaurant_mutation_sequence,
                customer_id: value.customer_id,
                order_id: value.order_id,
                chair_instance_id: value.chair_instance_id,
                table_instance_id: value.table_instance_id,
                chef_employee_id: value.chef_employee_id,
                kitchen_instance_id: value.kitchen_instance_id,
                waiter_employee_id: value.waiter_employee_id,
                waiter_tile: TilePoint {
                    x: value.waiter_tile_x,
                    y: value.waiter_tile_y,
                },
            },
            state: value.state,
            timing_anchored: value.timing_anchored,
            deadlines,
            active_path: value.active_path,
        })
    }
}

impl From<ServiceMutationOperation> for PersistedServiceMutationOperation {
    fn from(value: ServiceMutationOperation) -> Self {
        match value {
            ServiceMutationOperation::Start {
                restaurant_mutation_sequence,
                assignment,
                effective_at_ms,
            } => Self::Start {
                restaurant_mutation_sequence,
                assignment: assignment.into(),
                effective_at_ms,
            },
            ServiceMutationOperation::AnchorTiming {
                service_id,
                effective_at_ms,
            } => Self::AnchorTiming {
                service_id,
                effective_at_ms,
            },
            ServiceMutationOperation::Transition {
                service_id,
                event,
                effective_at_ms,
            } => Self::Transition {
                service_id,
                event,
                effective_at_ms,
            },
            ServiceMutationOperation::StartCustomerChairPath {
                service_id,
                start_tile,
                effective_at_ms,
            } => Self::StartCustomerChairPath {
                service_id,
                start_tile_x: start_tile.x,
                start_tile_y: start_tile.y,
                effective_at_ms,
            },
            ServiceMutationOperation::CompleteCustomerChairPath {
                service_id,
                effective_at_ms,
            } => Self::CompleteCustomerChairPath {
                service_id,
                effective_at_ms,
            },
            ServiceMutationOperation::Complete { service_id } => Self::Complete { service_id },
        }
    }
}

impl From<PersistedServiceMutationOperation> for ServiceMutationOperation {
    fn from(value: PersistedServiceMutationOperation) -> Self {
        match value {
            PersistedServiceMutationOperation::Start {
                restaurant_mutation_sequence,
                assignment,
                effective_at_ms,
            } => Self::Start {
                restaurant_mutation_sequence,
                assignment: assignment.into(),
                effective_at_ms,
            },
            PersistedServiceMutationOperation::AnchorTiming {
                service_id,
                effective_at_ms,
            } => Self::AnchorTiming {
                service_id,
                effective_at_ms,
            },
            PersistedServiceMutationOperation::Transition {
                service_id,
                event,
                effective_at_ms,
            } => Self::Transition {
                service_id,
                event,
                effective_at_ms,
            },
            PersistedServiceMutationOperation::StartCustomerChairPath {
                service_id,
                start_tile_x,
                start_tile_y,
                effective_at_ms,
            } => Self::StartCustomerChairPath {
                service_id,
                start_tile: TilePoint {
                    x: start_tile_x,
                    y: start_tile_y,
                },
                effective_at_ms,
            },
            PersistedServiceMutationOperation::CompleteCustomerChairPath {
                service_id,
                effective_at_ms,
            } => Self::CompleteCustomerChairPath {
                service_id,
                effective_at_ms,
            },
            PersistedServiceMutationOperation::Complete { service_id } => {
                Self::Complete { service_id }
            }
        }
    }
}

impl ProductAggregate {
    pub fn new(subject: AnewSubject, room: RoomDimensions) -> Self {
        Self {
            player: PlayerState::new(subject),
            restaurant: RestaurantState::new(room),
            restaurant_mutations: BTreeMap::new(),
            next_restaurant_mutation_sequence: 1,
            floor_tiles: BTreeMap::new(),
            floor_mutations: BTreeMap::new(),
            next_floor_mutation_sequence: 1,
            wallpapers: BTreeMap::new(),
            wallpaper_mutations: BTreeMap::new(),
            next_wallpaper_mutation_sequence: 1,
            active_service: None,
            service_mutations: BTreeMap::new(),
            next_service_mutation_sequence: 1,
            next_service_id: 1,
        }
    }

    pub fn subject(&self) -> AnewSubject {
        *self.player.subject()
    }

    pub fn player(&self) -> &PlayerState {
        &self.player
    }

    pub fn restaurant(&self) -> &RestaurantState {
        &self.restaurant
    }

    pub fn active_service(&self) -> Option<ActiveServiceRecord> {
        self.active_service
    }

    pub(crate) fn encode_persisted(&self) -> Result<Vec<u8>, ProductStateStoreError> {
        let snapshot = self.restaurant.snapshot();
        let persisted = PersistedAggregate {
            schema_version: PRODUCT_PERSISTENCE_SCHEMA_VERSION,
            player: self.player.persistence_snapshot(),
            restaurant: PersistedRestaurant {
                room: PersistedRoom::from(snapshot.room),
                next_instance_id: snapshot.next_instance_id,
                items: snapshot
                    .items
                    .into_iter()
                    .map(PersistedPlacedItem::from)
                    .collect(),
                floor_tiles: self
                    .floor_tiles
                    .values()
                    .copied()
                    .map(PersistedFloorTile::from)
                    .collect(),
                wallpapers: self
                    .wallpapers
                    .values()
                    .copied()
                    .map(PersistedWallpaper::from)
                    .collect(),
            },
            next_restaurant_mutation_sequence: self.next_restaurant_mutation_sequence,
            restaurant_mutations: self
                .restaurant_mutations
                .iter()
                .map(|(mutation_id, record)| PersistedRestaurantMutation {
                    mutation_id: mutation_id.as_str().to_owned(),
                    sequence: record.sequence,
                    operation: record.operation.into(),
                    item: PersistedPlacedItem::from(record.item),
                })
                .collect(),
            next_floor_mutation_sequence: self.next_floor_mutation_sequence,
            floor_mutations: self
                .floor_mutations
                .iter()
                .map(|(mutation_id, record)| PersistedFloorTileMutation {
                    mutation_id: mutation_id.as_str().to_owned(),
                    sequence: record.sequence,
                    tile: PersistedFloorTile::from(record.tile),
                })
                .collect(),
            next_wallpaper_mutation_sequence: self.next_wallpaper_mutation_sequence,
            wallpaper_mutations: self
                .wallpaper_mutations
                .iter()
                .map(|(mutation_id, record)| PersistedWallpaperMutation {
                    mutation_id: mutation_id.as_str().to_owned(),
                    sequence: record.sequence,
                    operation: record.operation.into(),
                    wallpaper: PersistedWallpaper::from(record.wallpaper),
                })
                .collect(),
            active_service: self.active_service.map(PersistedActiveService::from),
            service_mutations: self
                .service_mutations
                .iter()
                .map(|(mutation_id, record)| PersistedServiceMutation {
                    mutation_id: mutation_id.as_str().to_owned(),
                    sequence: record.sequence,
                    operation: record.operation.into(),
                    result: record.result.map(PersistedActiveService::from),
                })
                .collect(),
            next_service_mutation_sequence: self.next_service_mutation_sequence,
            next_service_id: self.next_service_id,
        };

        serde_json::to_vec(&persisted).map_err(|_| ProductStateStoreError::Corrupt)
    }

    pub(crate) fn decode_persisted(
        catalog: &PlacementCatalog,
        bytes: &[u8],
    ) -> Result<Self, ProductStateStoreError> {
        let header: PersistedSchemaHeader =
            serde_json::from_slice(bytes).map_err(|_| ProductStateStoreError::Corrupt)?;

        match header.schema_version {
            LEGACY_PRODUCT_PERSISTENCE_SCHEMA_VERSION => {
                let persisted: LegacyPersistedAggregate =
                    serde_json::from_slice(bytes).map_err(|_| ProductStateStoreError::Corrupt)?;
                Self::decode_legacy_persisted(catalog, persisted)
            }
            JOURNALED_OBJECT_PERSISTENCE_SCHEMA_VERSION => {
                let persisted: PersistedAggregate =
                    serde_json::from_slice(bytes).map_err(|_| ProductStateStoreError::Corrupt)?;
                Self::decode_v2_persisted(catalog, persisted)
            }
            FLOOR_TILE_PERSISTENCE_SCHEMA_VERSION => {
                let persisted: PersistedAggregate =
                    serde_json::from_slice(bytes).map_err(|_| ProductStateStoreError::Corrupt)?;
                Self::decode_v3_persisted(catalog, persisted)
            }
            WALLPAPER_PERSISTENCE_SCHEMA_VERSION => {
                let persisted: PersistedAggregate =
                    serde_json::from_slice(bytes).map_err(|_| ProductStateStoreError::Corrupt)?;
                Self::decode_v4_persisted(catalog, persisted)
            }
            ACTIVE_SERVICE_PERSISTENCE_SCHEMA_VERSION => {
                let persisted: PersistedAggregate =
                    serde_json::from_slice(bytes).map_err(|_| ProductStateStoreError::Corrupt)?;
                Self::decode_v5_persisted(catalog, persisted)
            }
            TIMED_SERVICE_PERSISTENCE_SCHEMA_VERSION => {
                let persisted: PersistedAggregate =
                    serde_json::from_slice(bytes).map_err(|_| ProductStateStoreError::Corrupt)?;
                Self::decode_v6_persisted(catalog, persisted)
            }
            PRODUCT_PERSISTENCE_SCHEMA_VERSION => {
                let persisted: PersistedAggregate =
                    serde_json::from_slice(bytes).map_err(|_| ProductStateStoreError::Corrupt)?;
                Self::decode_current_persisted(catalog, persisted)
            }
            _ => Err(ProductStateStoreError::Corrupt),
        }
    }

    fn decode_player_and_restaurant(
        catalog: &PlacementCatalog,
        player_snapshot: PlayerPersistenceSnapshot,
        persisted_restaurant: PersistedRestaurant,
    ) -> Result<(PlayerState, RestaurantState), ProductStateStoreError> {
        let player = PlayerState::from_persistence_snapshot(player_snapshot)
            .map_err(|_| ProductStateStoreError::Corrupt)?;

        let snapshot = RestaurantSnapshot {
            room: persisted_restaurant.room.into(),
            next_instance_id: persisted_restaurant.next_instance_id,
            items: persisted_restaurant
                .items
                .into_iter()
                .map(PlacedItem::from)
                .collect(),
        };
        let restaurant = RestaurantState::from_snapshot(catalog, snapshot)
            .map_err(|_| ProductStateStoreError::Corrupt)?;

        Self::validate_inventory_against_restaurant(
            &player,
            &restaurant,
            &BTreeMap::new(),
            &BTreeMap::new(),
        )?;
        Ok((player, restaurant))
    }

    fn validate_inventory_against_restaurant(
        player: &PlayerState,
        restaurant: &RestaurantState,
        floor_tiles: &BTreeMap<FloorTileKey, PaintedFloorTile>,
        wallpapers: &BTreeMap<WallpaperOrientation, AppliedWallpaper>,
    ) -> Result<(), ProductStateStoreError> {
        let mut placed_counts = BTreeMap::<u32, u32>::new();
        for item in restaurant.items() {
            let count = placed_counts.entry(item.item_id).or_default();
            *count = count
                .checked_add(1)
                .ok_or(ProductStateStoreError::Corrupt)?;
        }
        for tile in floor_tiles.values() {
            let count = placed_counts.entry(tile.item_id).or_default();
            *count = count
                .checked_add(1)
                .ok_or(ProductStateStoreError::Corrupt)?;
        }
        for wallpaper in wallpapers.values() {
            let count = placed_counts.entry(wallpaper.item_id).or_default();
            *count = count
                .checked_add(1)
                .ok_or(ProductStateStoreError::Corrupt)?;
        }

        if placed_counts
            .iter()
            .any(|(item_id, placed)| player.inventory().quantity(*item_id) < *placed)
        {
            return Err(ProductStateStoreError::Corrupt);
        }
        Ok(())
    }

    fn decode_legacy_persisted(
        catalog: &PlacementCatalog,
        persisted: LegacyPersistedAggregate,
    ) -> Result<Self, ProductStateStoreError> {
        if persisted.schema_version != LEGACY_PRODUCT_PERSISTENCE_SCHEMA_VERSION
            || !persisted.restaurant.floor_tiles.is_empty()
            || !persisted.restaurant.wallpapers.is_empty()
        {
            return Err(ProductStateStoreError::Corrupt);
        }

        let (player, restaurant) =
            Self::decode_player_and_restaurant(catalog, persisted.player, persisted.restaurant)?;
        let authoritative_items: BTreeMap<_, _> = restaurant
            .items()
            .map(|item| (item.instance_id, *item))
            .collect();

        let mut seen_mutation_ids = BTreeMap::<MutationId, ()>::new();
        let mut seen_instances = BTreeMap::<u64, ()>::new();
        let mut legacy_records = Vec::new();

        for entry in persisted.placement_mutations {
            let mutation_id = MutationId::from_persisted(entry.mutation_id)
                .map_err(|_| ProductStateStoreError::Corrupt)?;
            let placed = PlacedItem::from(entry.item);

            if authoritative_items.get(&placed.instance_id) != Some(&placed)
                || seen_mutation_ids.insert(mutation_id.clone(), ()).is_some()
                || seen_instances.insert(placed.instance_id, ()).is_some()
            {
                return Err(ProductStateStoreError::Corrupt);
            }
            legacy_records.push((mutation_id, placed));
        }

        if legacy_records.len() != authoritative_items.len() {
            return Err(ProductStateStoreError::Corrupt);
        }

        legacy_records.sort_by_key(|(_, item)| item.instance_id);
        let mut restaurant_mutations = BTreeMap::new();
        for (index, (mutation_id, item)) in legacy_records.into_iter().enumerate() {
            let sequence = u64::try_from(index)
                .map_err(|_| ProductStateStoreError::Corrupt)?
                .checked_add(1)
                .ok_or(ProductStateStoreError::Corrupt)?;
            restaurant_mutations.insert(
                mutation_id,
                RestaurantMutationRecord {
                    sequence,
                    operation: RestaurantMutationOperation::Place,
                    item,
                },
            );
        }

        let next_restaurant_mutation_sequence = u64::try_from(restaurant_mutations.len())
            .map_err(|_| ProductStateStoreError::Corrupt)?
            .checked_add(1)
            .ok_or(ProductStateStoreError::Corrupt)?;

        Ok(Self {
            player,
            restaurant,
            restaurant_mutations,
            next_restaurant_mutation_sequence,
            floor_tiles: BTreeMap::new(),
            floor_mutations: BTreeMap::new(),
            next_floor_mutation_sequence: 1,
            wallpapers: BTreeMap::new(),
            wallpaper_mutations: BTreeMap::new(),
            next_wallpaper_mutation_sequence: 1,
            active_service: None,
            service_mutations: BTreeMap::new(),
            next_service_mutation_sequence: 1,
            next_service_id: 1,
        })
    }

    fn decode_v2_persisted(
        catalog: &PlacementCatalog,
        mut persisted: PersistedAggregate,
    ) -> Result<Self, ProductStateStoreError> {
        if persisted.schema_version != JOURNALED_OBJECT_PERSISTENCE_SCHEMA_VERSION
            || !persisted.restaurant.floor_tiles.is_empty()
            || !persisted.restaurant.wallpapers.is_empty()
            || persisted.next_floor_mutation_sequence != 0
            || !persisted.floor_mutations.is_empty()
            || persisted.next_wallpaper_mutation_sequence != 0
            || !persisted.wallpaper_mutations.is_empty()
        {
            return Err(ProductStateStoreError::Corrupt);
        }

        // V2 predates floor, wallpaper and live-service state.
        persisted.schema_version = PRODUCT_PERSISTENCE_SCHEMA_VERSION;
        persisted.next_floor_mutation_sequence = 1;
        persisted.next_wallpaper_mutation_sequence = 1;
        persisted.next_service_mutation_sequence = 1;
        persisted.next_service_id = 1;
        Self::decode_current_persisted(catalog, persisted)
    }

    fn decode_v3_persisted(
        catalog: &PlacementCatalog,
        mut persisted: PersistedAggregate,
    ) -> Result<Self, ProductStateStoreError> {
        if persisted.schema_version != FLOOR_TILE_PERSISTENCE_SCHEMA_VERSION
            || !persisted.restaurant.wallpapers.is_empty()
            || persisted.next_wallpaper_mutation_sequence != 0
            || !persisted.wallpaper_mutations.is_empty()
        {
            return Err(ProductStateStoreError::Corrupt);
        }

        // V3 already has object + floor journals; V4 added wallpaper slots,
        // while V5 adds durable live-service identity.
        persisted.schema_version = PRODUCT_PERSISTENCE_SCHEMA_VERSION;
        persisted.next_wallpaper_mutation_sequence = 1;
        persisted.next_service_mutation_sequence = 1;
        persisted.next_service_id = 1;
        Self::decode_current_persisted(catalog, persisted)
    }

    fn decode_v4_persisted(
        catalog: &PlacementCatalog,
        mut persisted: PersistedAggregate,
    ) -> Result<Self, ProductStateStoreError> {
        if persisted.schema_version != WALLPAPER_PERSISTENCE_SCHEMA_VERSION
            || persisted.active_service.is_some()
            || !persisted.service_mutations.is_empty()
            || persisted.next_service_mutation_sequence != 0
            || persisted.next_service_id != 0
        {
            return Err(ProductStateStoreError::Corrupt);
        }

        persisted.schema_version = PRODUCT_PERSISTENCE_SCHEMA_VERSION;
        persisted.next_service_mutation_sequence = 1;
        persisted.next_service_id = 1;
        Self::decode_current_persisted(catalog, persisted)
    }

    fn decode_v5_persisted(
        catalog: &PlacementCatalog,
        mut persisted: PersistedAggregate,
    ) -> Result<Self, ProductStateStoreError> {
        if persisted.schema_version != ACTIVE_SERVICE_PERSISTENCE_SCHEMA_VERSION {
            return Err(ProductStateStoreError::Corrupt);
        }

        // V5 predates authoritative wall-clock deadlines. Its service journal
        // is replayed exactly as an unanchored legacy prefix. No timestamp is
        // invented during decode; the first V6 server access must explicitly
        // append AnchorTiming before any timed transition can occur.
        persisted.schema_version = PRODUCT_PERSISTENCE_SCHEMA_VERSION;
        Self::decode_current_persisted(catalog, persisted)
    }

    fn decode_v6_persisted(
        catalog: &PlacementCatalog,
        mut persisted: PersistedAggregate,
    ) -> Result<Self, ProductStateStoreError> {
        if persisted.schema_version != TIMED_SERVICE_PERSISTENCE_SCHEMA_VERSION {
            return Err(ProductStateStoreError::Corrupt);
        }

        // V6 has authoritative wall-clock timing but predates persisted
        // path authority. The serde-defaulted active_path remains absent; no
        // legacy service is allowed to acquire a synthetic path during decode.
        if persisted
            .active_service
            .is_some_and(|service| service.active_path.is_some())
            || persisted
                .service_mutations
                .iter()
                .any(|entry| entry.result.is_some_and(|service| service.active_path.is_some()))
        {
            return Err(ProductStateStoreError::Corrupt);
        }
        persisted.schema_version = PRODUCT_PERSISTENCE_SCHEMA_VERSION;
        Self::decode_current_persisted(catalog, persisted)
    }

    fn decode_current_persisted(
        catalog: &PlacementCatalog,
        persisted: PersistedAggregate,
    ) -> Result<Self, ProductStateStoreError> {
        if persisted.schema_version != PRODUCT_PERSISTENCE_SCHEMA_VERSION
            || persisted.next_restaurant_mutation_sequence == 0
            || persisted.next_floor_mutation_sequence == 0
            || persisted.next_wallpaper_mutation_sequence == 0
            || persisted.next_service_mutation_sequence == 0
            || persisted.next_service_id == 0
        {
            return Err(ProductStateStoreError::Corrupt);
        }

        // V7 extends the V6 live-service journal with server-owned path
        // authority. Replay every domain, every deadline and every path plan
        // from journal operations rather
        // than trusting serialized result snapshots. A migrated V5 prefix is
        // permitted to remain unanchored until an explicit AnchorTiming entry.
        let player = PlayerState::from_persistence_snapshot(persisted.player)
            .map_err(|_| ProductStateStoreError::Corrupt)?;
        let PersistedRestaurant {
            room,
            next_instance_id,
            items,
            floor_tiles,
            wallpapers,
        } = persisted.restaurant;
        let room: RoomDimensions = room.into();
        let expected_restaurant = RestaurantSnapshot {
            room,
            next_instance_id,
            items: items.into_iter().map(PlacedItem::from).collect(),
        };
        let expected_floor_tiles = Self::decode_persisted_floor_tiles(catalog, room, floor_tiles)?;
        let expected_wallpapers = Self::decode_persisted_wallpapers(catalog, room, wallpapers)?;
        let mut restaurant_mutations = BTreeMap::new();
        let mut ordered = Vec::new();
        let mut seen_sequences = BTreeMap::<u64, ()>::new();

        for entry in persisted.restaurant_mutations {
            let mutation_id = MutationId::from_persisted(entry.mutation_id)
                .map_err(|_| ProductStateStoreError::Corrupt)?;
            if entry.sequence == 0 || seen_sequences.insert(entry.sequence, ()).is_some() {
                return Err(ProductStateStoreError::Corrupt);
            }

            let record = RestaurantMutationRecord {
                sequence: entry.sequence,
                operation: entry.operation.into(),
                item: PlacedItem::from(entry.item),
            };
            if restaurant_mutations
                .insert(mutation_id.clone(), record)
                .is_some()
            {
                return Err(ProductStateStoreError::Corrupt);
            }
            ordered.push((mutation_id, record));
        }

        ordered.sort_by_key(|(_, record)| record.sequence);
        for (index, (_, record)) in ordered.iter().enumerate() {
            let expected = u64::try_from(index)
                .map_err(|_| ProductStateStoreError::Corrupt)?
                .checked_add(1)
                .ok_or(ProductStateStoreError::Corrupt)?;
            if record.sequence != expected {
                return Err(ProductStateStoreError::Corrupt);
            }
        }

        let expected_next = u64::try_from(ordered.len())
            .map_err(|_| ProductStateStoreError::Corrupt)?
            .checked_add(1)
            .ok_or(ProductStateStoreError::Corrupt)?;
        if persisted.next_restaurant_mutation_sequence != expected_next {
            return Err(ProductStateStoreError::Corrupt);
        }

        let mut replay = RestaurantState::new(expected_restaurant.room);
        let mut restaurant_snapshots_by_sequence = BTreeMap::<u64, RestaurantSnapshot>::new();
        restaurant_snapshots_by_sequence.insert(0, replay.snapshot());
        for (_, record) in &ordered {
            let replayed = match record.operation {
                RestaurantMutationOperation::Place => replay
                    .place(
                        catalog,
                        PlacementIntent {
                            item_id: record.item.item_id,
                            tile: record.item.tile,
                            rotation: record.item.rotation,
                        },
                    )
                    .map_err(|_| ProductStateStoreError::Corrupt)?,
                RestaurantMutationOperation::Transform => replay
                    .transform(
                        catalog,
                        record.item.instance_id,
                        record.item.tile,
                        record.item.rotation,
                    )
                    .map_err(|_| ProductStateStoreError::Corrupt)?,
                RestaurantMutationOperation::Remove => replay
                    .remove(record.item.instance_id)
                    .map_err(|_| ProductStateStoreError::Corrupt)?,
            };

            if replayed != record.item {
                return Err(ProductStateStoreError::Corrupt);
            }
            restaurant_snapshots_by_sequence.insert(record.sequence, replay.snapshot());
        }

        let replay_snapshot = replay.snapshot();
        if !restaurant_snapshots_match_content(&replay_snapshot, &expected_restaurant) {
            return Err(ProductStateStoreError::Corrupt);
        }

        let mut floor_mutations = BTreeMap::new();
        let mut ordered_floor = Vec::new();
        let mut seen_floor_sequences = BTreeMap::<u64, ()>::new();
        for entry in persisted.floor_mutations {
            let mutation_id = MutationId::from_persisted(entry.mutation_id)
                .map_err(|_| ProductStateStoreError::Corrupt)?;
            if restaurant_mutations.contains_key(&mutation_id)
                || entry.sequence == 0
                || seen_floor_sequences.insert(entry.sequence, ()).is_some()
            {
                return Err(ProductStateStoreError::Corrupt);
            }

            let requested = PaintedFloorTile::from(entry.tile);
            let validated = validate_floor_tile_intent(
                catalog,
                room,
                FloorTileIntent {
                    item_id: requested.item_id,
                    tile: requested.tile,
                },
            )
            .map_err(|_| ProductStateStoreError::Corrupt)?;
            if validated != requested {
                return Err(ProductStateStoreError::Corrupt);
            }

            let record = FloorTileMutationRecord {
                sequence: entry.sequence,
                tile: validated,
            };
            if floor_mutations
                .insert(mutation_id.clone(), record)
                .is_some()
            {
                return Err(ProductStateStoreError::Corrupt);
            }
            ordered_floor.push((mutation_id, record));
        }

        ordered_floor.sort_by_key(|(_, record)| record.sequence);
        for (index, (_, record)) in ordered_floor.iter().enumerate() {
            let expected = u64::try_from(index)
                .map_err(|_| ProductStateStoreError::Corrupt)?
                .checked_add(1)
                .ok_or(ProductStateStoreError::Corrupt)?;
            if record.sequence != expected {
                return Err(ProductStateStoreError::Corrupt);
            }
        }
        let expected_floor_next = u64::try_from(ordered_floor.len())
            .map_err(|_| ProductStateStoreError::Corrupt)?
            .checked_add(1)
            .ok_or(ProductStateStoreError::Corrupt)?;
        if persisted.next_floor_mutation_sequence != expected_floor_next {
            return Err(ProductStateStoreError::Corrupt);
        }

        let mut replay_floor_tiles = BTreeMap::new();
        for (_, record) in &ordered_floor {
            replay_floor_tiles.insert(FloorTileKey::from(record.tile), record.tile);
        }
        if replay_floor_tiles != expected_floor_tiles {
            return Err(ProductStateStoreError::Corrupt);
        }

        let mut wallpaper_mutations = BTreeMap::new();
        let mut ordered_wallpaper = Vec::new();
        let mut seen_wallpaper_sequences = BTreeMap::<u64, ()>::new();
        for entry in persisted.wallpaper_mutations {
            let mutation_id = MutationId::from_persisted(entry.mutation_id)
                .map_err(|_| ProductStateStoreError::Corrupt)?;
            if restaurant_mutations.contains_key(&mutation_id)
                || floor_mutations.contains_key(&mutation_id)
                || entry.sequence == 0
                || seen_wallpaper_sequences
                    .insert(entry.sequence, ())
                    .is_some()
            {
                return Err(ProductStateStoreError::Corrupt);
            }

            let wallpaper = AppliedWallpaper::try_from(entry.wallpaper)
                .map_err(|_| ProductStateStoreError::Corrupt)?;
            let validated = Self::validate_persisted_wallpaper(catalog, room, wallpaper)?;
            let record = WallpaperMutationRecord {
                sequence: entry.sequence,
                operation: entry.operation.into(),
                wallpaper: validated,
            };
            if wallpaper_mutations
                .insert(mutation_id.clone(), record)
                .is_some()
            {
                return Err(ProductStateStoreError::Corrupt);
            }
            ordered_wallpaper.push((mutation_id, record));
        }

        ordered_wallpaper.sort_by_key(|(_, record)| record.sequence);
        for (index, (_, record)) in ordered_wallpaper.iter().enumerate() {
            let expected = u64::try_from(index)
                .map_err(|_| ProductStateStoreError::Corrupt)?
                .checked_add(1)
                .ok_or(ProductStateStoreError::Corrupt)?;
            if record.sequence != expected {
                return Err(ProductStateStoreError::Corrupt);
            }
        }
        let expected_wallpaper_next = u64::try_from(ordered_wallpaper.len())
            .map_err(|_| ProductStateStoreError::Corrupt)?
            .checked_add(1)
            .ok_or(ProductStateStoreError::Corrupt)?;
        if persisted.next_wallpaper_mutation_sequence != expected_wallpaper_next {
            return Err(ProductStateStoreError::Corrupt);
        }

        let mut replay_wallpapers = BTreeMap::new();
        for (_, record) in &ordered_wallpaper {
            match record.operation {
                WallpaperMutationOperation::Apply => {
                    replay_wallpapers.insert(record.wallpaper.orientation, record.wallpaper);
                }
                WallpaperMutationOperation::Remove => {
                    if replay_wallpapers.remove(&record.wallpaper.orientation)
                        != Some(record.wallpaper)
                    {
                        return Err(ProductStateStoreError::Corrupt);
                    }
                }
            }
        }
        if replay_wallpapers != expected_wallpapers {
            return Err(ProductStateStoreError::Corrupt);
        }

        let expected_active_service = persisted
            .active_service
            .map(ActiveServiceRecord::try_from)
            .transpose()?;
        let mut service_mutations = BTreeMap::new();
        let mut ordered_service = Vec::new();
        let mut seen_service_sequences = BTreeMap::<u64, ()>::new();

        for entry in persisted.service_mutations {
            let mutation_id = MutationId::from_persisted(entry.mutation_id)
                .map_err(|_| ProductStateStoreError::Corrupt)?;
            if restaurant_mutations.contains_key(&mutation_id)
                || floor_mutations.contains_key(&mutation_id)
                || wallpaper_mutations.contains_key(&mutation_id)
                || entry.sequence == 0
                || seen_service_sequences.insert(entry.sequence, ()).is_some()
            {
                return Err(ProductStateStoreError::Corrupt);
            }

            let record = ServiceMutationRecord {
                sequence: entry.sequence,
                operation: entry.operation.into(),
                result: entry
                    .result
                    .map(ActiveServiceRecord::try_from)
                    .transpose()?,
            };
            if service_mutations
                .insert(mutation_id.clone(), record)
                .is_some()
            {
                return Err(ProductStateStoreError::Corrupt);
            }
            ordered_service.push((mutation_id, record));
        }

        ordered_service.sort_by_key(|(_, record)| record.sequence);
        for (index, (_, record)) in ordered_service.iter().enumerate() {
            let expected = u64::try_from(index)
                .map_err(|_| ProductStateStoreError::Corrupt)?
                .checked_add(1)
                .ok_or(ProductStateStoreError::Corrupt)?;
            if record.sequence != expected {
                return Err(ProductStateStoreError::Corrupt);
            }
        }
        let expected_service_next = u64::try_from(ordered_service.len())
            .map_err(|_| ProductStateStoreError::Corrupt)?
            .checked_add(1)
            .ok_or(ProductStateStoreError::Corrupt)?;
        if persisted.next_service_mutation_sequence != expected_service_next {
            return Err(ProductStateStoreError::Corrupt);
        }

        let mut replay_active_service: Option<ActiveServiceRecord> = None;
        let mut replay_next_service_id = 1_u64;
        for (_, record) in &ordered_service {
            match record.operation {
                ServiceMutationOperation::Start {
                    restaurant_mutation_sequence,
                    assignment,
                    effective_at_ms,
                } => {
                    if replay_active_service.is_some() {
                        return Err(ProductStateStoreError::Corrupt);
                    }
                    let source_restaurant = restaurant_snapshots_by_sequence
                        .get(&restaurant_mutation_sequence)
                        .ok_or(ProductStateStoreError::Corrupt)?;
                    let mut started = ActiveServiceRecord::start(
                        replay_next_service_id,
                        restaurant_mutation_sequence,
                        assignment,
                        source_restaurant,
                        catalog,
                    )
                    .map_err(|_| ProductStateStoreError::Corrupt)?;
                    if let Some(effective_at_ms) = effective_at_ms {
                        started = started
                            .anchor_timing(effective_at_ms)
                            .map_err(|_| ProductStateStoreError::Corrupt)?;
                    }
                    replay_next_service_id = replay_next_service_id
                        .checked_add(1)
                        .ok_or(ProductStateStoreError::Corrupt)?;
                    replay_active_service = Some(started);
                }
                ServiceMutationOperation::AnchorTiming {
                    service_id,
                    effective_at_ms,
                } => {
                    let current = replay_active_service.ok_or(ProductStateStoreError::Corrupt)?;
                    if current.identity.service_id != service_id || current.timing_anchored {
                        return Err(ProductStateStoreError::Corrupt);
                    }
                    replay_active_service = Some(
                        current
                            .anchor_timing(effective_at_ms)
                            .map_err(|_| ProductStateStoreError::Corrupt)?,
                    );
                }
                ServiceMutationOperation::Transition {
                    service_id,
                    event,
                    effective_at_ms,
                } => {
                    let current = replay_active_service.ok_or(ProductStateStoreError::Corrupt)?;
                    if current.identity.service_id != service_id {
                        return Err(ProductStateStoreError::Corrupt);
                    }
                    let (transitioned, effect) = match (current.timing_anchored, effective_at_ms) {
                        (false, None) => current
                            .transition(event)
                            .map_err(|_| ProductStateStoreError::Corrupt)?,
                        (true, Some(effective_at_ms)) => current
                            .transition_at(event, effective_at_ms)
                            .map_err(|_| ProductStateStoreError::Corrupt)?,
                        _ => return Err(ProductStateStoreError::Corrupt),
                    };
                    if effect.is_some() {
                        return Err(ProductStateStoreError::Corrupt);
                    }
                    replay_active_service = Some(transitioned);
                }
                ServiceMutationOperation::StartCustomerChairPath {
                    service_id,
                    start_tile,
                    effective_at_ms,
                } => {
                    let current = replay_active_service.ok_or(ProductStateStoreError::Corrupt)?;
                    if current.identity.service_id != service_id || current.active_path.is_some() {
                        return Err(ProductStateStoreError::Corrupt);
                    }
                    let source_restaurant = restaurant_snapshots_by_sequence
                        .get(&current.identity.restaurant_mutation_sequence)
                        .ok_or(ProductStateStoreError::Corrupt)?;
                    let layout = derive_service_layout(source_restaurant, catalog)
                        .map_err(|_| ProductStateStoreError::Corrupt)?;
                    let plan = plan_customer_path_to_chair(
                        &layout,
                        start_tile,
                        current.identity.chair_instance_id,
                        effective_at_ms,
                    )
                    .map_err(|_| ProductStateStoreError::Corrupt)?;
                    let (walking, effect) = current
                        .transition_at(ServiceLoopEvent::StartChairWalk, effective_at_ms)
                        .map_err(|_| ProductStateStoreError::Corrupt)?;
                    if effect.is_some() {
                        return Err(ProductStateStoreError::Corrupt);
                    }
                    replay_active_service = Some(ActiveServiceRecord {
                        active_path: Some(plan),
                        ..walking
                    });
                }
                ServiceMutationOperation::CompleteCustomerChairPath {
                    service_id,
                    effective_at_ms,
                } => {
                    let current = replay_active_service.ok_or(ProductStateStoreError::Corrupt)?;
                    if current.identity.service_id != service_id {
                        return Err(ProductStateStoreError::Corrupt);
                    }
                    let plan = current.active_path.ok_or(ProductStateStoreError::Corrupt)?;
                    if plan.kind != ServicePathKind::CustomerToChair
                        || plan.completes_at_ms != effective_at_ms
                    {
                        return Err(ProductStateStoreError::Corrupt);
                    }
                    let source_restaurant = restaurant_snapshots_by_sequence
                        .get(&current.identity.restaurant_mutation_sequence)
                        .ok_or(ProductStateStoreError::Corrupt)?;
                    let layout = derive_service_layout(source_restaurant, catalog)
                        .map_err(|_| ProductStateStoreError::Corrupt)?;
                    validate_customer_path_to_chair_plan(
                        &layout,
                        current.identity.chair_instance_id,
                        plan,
                    )
                    .map_err(|_| ProductStateStoreError::Corrupt)?;
                    let (deciding, effect) = current
                        .transition_at(ServiceLoopEvent::ReachChair, effective_at_ms)
                        .map_err(|_| ProductStateStoreError::Corrupt)?;
                    if effect.is_some() {
                        return Err(ProductStateStoreError::Corrupt);
                    }
                    replay_active_service = Some(ActiveServiceRecord {
                        active_path: None,
                        ..deciding
                    });
                }
                ServiceMutationOperation::Complete { service_id } => {
                    let current = replay_active_service.ok_or(ProductStateStoreError::Corrupt)?;
                    if current.identity.service_id != service_id
                        || current.state.customer != CustomerServiceState::Left
                        || current.state.order != OrderServiceState::Settled
                    {
                        return Err(ProductStateStoreError::Corrupt);
                    }
                    replay_active_service = None;
                }
            }

            if replay_active_service != record.result {
                return Err(ProductStateStoreError::Corrupt);
            }
        }

        if replay_active_service != expected_active_service
            || replay_next_service_id != persisted.next_service_id
        {
            return Err(ProductStateStoreError::Corrupt);
        }

        Self::validate_inventory_against_restaurant(
            &player,
            &replay,
            &replay_floor_tiles,
            &replay_wallpapers,
        )?;

        Ok(Self {
            player,
            restaurant: replay,
            restaurant_mutations,
            next_restaurant_mutation_sequence: persisted.next_restaurant_mutation_sequence,
            floor_tiles: replay_floor_tiles,
            floor_mutations,
            next_floor_mutation_sequence: persisted.next_floor_mutation_sequence,
            wallpapers: replay_wallpapers,
            wallpaper_mutations,
            next_wallpaper_mutation_sequence: persisted.next_wallpaper_mutation_sequence,
            active_service: replay_active_service,
            service_mutations,
            next_service_mutation_sequence: persisted.next_service_mutation_sequence,
            next_service_id: persisted.next_service_id,
        })
    }

    fn validate_persisted_wallpaper(
        catalog: &PlacementCatalog,
        room: RoomDimensions,
        wallpaper: AppliedWallpaper,
    ) -> Result<AppliedWallpaper, ProductStateStoreError> {
        let wall_tile = match wallpaper.orientation {
            WallpaperOrientation::Left => TilePoint { x: 0, y: 1 },
            WallpaperOrientation::Top => TilePoint { x: 1, y: 0 },
        };
        let validated = validate_wallpaper_intent(
            catalog,
            room,
            WallpaperIntent {
                item_id: wallpaper.item_id,
                wall_tile,
            },
        )
        .map_err(|_| ProductStateStoreError::Corrupt)?;
        if validated != wallpaper {
            return Err(ProductStateStoreError::Corrupt);
        }
        Ok(validated)
    }

    fn decode_persisted_wallpapers(
        catalog: &PlacementCatalog,
        room: RoomDimensions,
        persisted: Vec<PersistedWallpaper>,
    ) -> Result<BTreeMap<WallpaperOrientation, AppliedWallpaper>, ProductStateStoreError> {
        let mut wallpapers = BTreeMap::new();
        for entry in persisted {
            let wallpaper =
                AppliedWallpaper::try_from(entry).map_err(|_| ProductStateStoreError::Corrupt)?;
            let validated = Self::validate_persisted_wallpaper(catalog, room, wallpaper)?;
            if wallpapers
                .insert(validated.orientation, validated)
                .is_some()
            {
                return Err(ProductStateStoreError::Corrupt);
            }
        }
        Ok(wallpapers)
    }

    fn decode_persisted_floor_tiles(
        catalog: &PlacementCatalog,
        room: RoomDimensions,
        persisted: Vec<PersistedFloorTile>,
    ) -> Result<BTreeMap<FloorTileKey, PaintedFloorTile>, ProductStateStoreError> {
        let mut floor_tiles = BTreeMap::new();
        for entry in persisted {
            let requested = PaintedFloorTile::from(entry);
            let validated = validate_floor_tile_intent(
                catalog,
                room,
                FloorTileIntent {
                    item_id: requested.item_id,
                    tile: requested.tile,
                },
            )
            .map_err(|_| ProductStateStoreError::Corrupt)?;
            if validated != requested
                || floor_tiles
                    .insert(FloorTileKey::from(validated), validated)
                    .is_some()
            {
                return Err(ProductStateStoreError::Corrupt);
            }
        }
        Ok(floor_tiles)
    }

    pub fn apply_player_command(
        &mut self,
        session: VerifiedProductSession,
        mutation_id: MutationId,
        command: Command,
    ) -> Result<MutationOutcome, ProductServiceError> {
        self.require_subject(session)?;

        if let Command::ConsumeInventory { item_id, quantity } = &command {
            let owned = self.player.inventory().quantity(*item_id);
            let placed = self.placed_count_for_item(*item_id)?;
            let available = owned
                .checked_sub(placed)
                .ok_or(ProductServiceError::Store(ProductStateStoreError::Corrupt))?;
            if *quantity > available {
                return Err(ProductServiceError::ItemUnavailable {
                    item_id: *item_id,
                    owned,
                    placed,
                });
            }
        }

        self.player
            .apply(mutation_id, command)
            .map_err(ProductServiceError::PlayerAuthority)
    }

    pub fn place_owned_item(
        &mut self,
        session: VerifiedProductSession,
        catalog: &PlacementCatalog,
        mutation_id: MutationId,
        intent: PlacementIntent,
    ) -> Result<PlacementMutationOutcome, ProductServiceError> {
        self.require_subject(session)?;

        if self.floor_mutations.contains_key(&mutation_id)
            || self.wallpaper_mutations.contains_key(&mutation_id)
            || self.service_mutations.contains_key(&mutation_id)
        {
            return Err(ProductServiceError::MutationIdConflict);
        }
        if let Some(existing) = self.restaurant_mutations.get(&mutation_id) {
            if existing.operation != RestaurantMutationOperation::Place
                || existing.item.item_id != intent.item_id
                || existing.item.tile != intent.tile
                || !mutation_rotation_matches(
                    catalog,
                    existing.item.item_id,
                    existing.item.rotation,
                    intent.rotation,
                )
            {
                return Err(ProductServiceError::MutationIdConflict);
            }
            return Ok(PlacementMutationOutcome::Duplicate(existing.item));
        }

        if self.active_service.is_some() {
            return Err(ProductServiceError::ActiveServiceLayoutLocked);
        }

        let owned = self.player.inventory().quantity(intent.item_id);
        let already_placed = self.placed_count_for_item(intent.item_id)?;

        if already_placed >= owned {
            return Err(ProductServiceError::ItemUnavailable {
                item_id: intent.item_id,
                owned,
                placed: already_placed,
            });
        }

        let placed = self
            .restaurant
            .place(catalog, intent)
            .map_err(ProductServiceError::RestaurantAuthority)?;

        self.record_restaurant_mutation(mutation_id, RestaurantMutationOperation::Place, placed)?;
        Ok(PlacementMutationOutcome::Applied(placed))
    }

    pub fn paint_owned_floor_tile(
        &mut self,
        session: VerifiedProductSession,
        catalog: &PlacementCatalog,
        mutation_id: MutationId,
        intent: FloorTileIntent,
    ) -> Result<FloorTileMutationOutcome, ProductServiceError> {
        self.require_subject(session)?;

        if self.restaurant_mutations.contains_key(&mutation_id)
            || self.wallpaper_mutations.contains_key(&mutation_id)
            || self.service_mutations.contains_key(&mutation_id)
        {
            return Err(ProductServiceError::MutationIdConflict);
        }
        if let Some(existing) = self.floor_mutations.get(&mutation_id) {
            if existing.tile.item_id != intent.item_id || existing.tile.tile != intent.tile {
                return Err(ProductServiceError::MutationIdConflict);
            }
            return Ok(FloorTileMutationOutcome::Duplicate(existing.tile));
        }

        let painted = validate_floor_tile_intent(catalog, self.restaurant.room(), intent)
            .map_err(ProductServiceError::RestaurantAuthority)?;
        let key = FloorTileKey::from(painted);
        let current = self.floor_tiles.get(&key).copied();

        if current.is_none_or(|existing| existing.item_id != painted.item_id) {
            let owned = self.player.inventory().quantity(painted.item_id);
            let placed = self.placed_count_for_item(painted.item_id)?;
            if placed >= owned {
                return Err(ProductServiceError::ItemUnavailable {
                    item_id: painted.item_id,
                    owned,
                    placed,
                });
            }
        }

        self.floor_tiles.insert(key, painted);
        self.record_floor_mutation(mutation_id, painted)?;
        Ok(FloorTileMutationOutcome::Applied(painted))
    }

    pub fn apply_owned_wallpaper(
        &mut self,
        session: VerifiedProductSession,
        catalog: &PlacementCatalog,
        mutation_id: MutationId,
        intent: WallpaperIntent,
    ) -> Result<WallpaperMutationOutcome, ProductServiceError> {
        self.require_subject(session)?;

        if self.restaurant_mutations.contains_key(&mutation_id)
            || self.floor_mutations.contains_key(&mutation_id)
            || self.service_mutations.contains_key(&mutation_id)
        {
            return Err(ProductServiceError::MutationIdConflict);
        }

        let wallpaper = validate_wallpaper_intent(catalog, self.restaurant.room(), intent)
            .map_err(ProductServiceError::RestaurantAuthority)?;

        if let Some(existing) = self.wallpaper_mutations.get(&mutation_id) {
            if existing.operation != WallpaperMutationOperation::Apply
                || existing.wallpaper != wallpaper
            {
                return Err(ProductServiceError::MutationIdConflict);
            }
            return Ok(WallpaperMutationOutcome::Duplicate(existing.wallpaper));
        }

        let current = self.wallpapers.get(&wallpaper.orientation).copied();
        if current.is_none_or(|existing| existing.item_id != wallpaper.item_id) {
            let owned = self.player.inventory().quantity(wallpaper.item_id);
            let placed = self.placed_count_for_item(wallpaper.item_id)?;
            if placed >= owned {
                return Err(ProductServiceError::ItemUnavailable {
                    item_id: wallpaper.item_id,
                    owned,
                    placed,
                });
            }
        }

        self.wallpapers.insert(wallpaper.orientation, wallpaper);
        self.record_wallpaper_mutation(mutation_id, WallpaperMutationOperation::Apply, wallpaper)?;
        Ok(WallpaperMutationOutcome::Applied(wallpaper))
    }

    pub fn remove_owned_wallpaper(
        &mut self,
        session: VerifiedProductSession,
        mutation_id: MutationId,
        orientation: WallpaperOrientation,
    ) -> Result<WallpaperMutationOutcome, ProductServiceError> {
        self.require_subject(session)?;

        if self.restaurant_mutations.contains_key(&mutation_id)
            || self.floor_mutations.contains_key(&mutation_id)
            || self.service_mutations.contains_key(&mutation_id)
        {
            return Err(ProductServiceError::MutationIdConflict);
        }
        if let Some(existing) = self.wallpaper_mutations.get(&mutation_id) {
            if existing.operation != WallpaperMutationOperation::Remove
                || existing.wallpaper.orientation != orientation
            {
                return Err(ProductServiceError::MutationIdConflict);
            }
            return Ok(WallpaperMutationOutcome::Duplicate(existing.wallpaper));
        }

        let removed = self.wallpapers.remove(&orientation).ok_or(
            ProductServiceError::WallpaperNotApplied {
                rotation: orientation.rotation(),
            },
        )?;

        self.record_wallpaper_mutation(mutation_id, WallpaperMutationOperation::Remove, removed)?;
        Ok(WallpaperMutationOutcome::Applied(removed))
    }

    pub fn transform_owned_item(
        &mut self,
        session: VerifiedProductSession,
        catalog: &PlacementCatalog,
        mutation_id: MutationId,
        instance_id: u64,
        tile: TilePoint,
        rotation: u8,
    ) -> Result<PlacementMutationOutcome, ProductServiceError> {
        self.require_subject(session)?;

        if self.floor_mutations.contains_key(&mutation_id)
            || self.wallpaper_mutations.contains_key(&mutation_id)
            || self.service_mutations.contains_key(&mutation_id)
        {
            return Err(ProductServiceError::MutationIdConflict);
        }
        if let Some(existing) = self.restaurant_mutations.get(&mutation_id) {
            if existing.operation != RestaurantMutationOperation::Transform
                || existing.item.instance_id != instance_id
                || existing.item.tile != tile
                || !mutation_rotation_matches(
                    catalog,
                    existing.item.item_id,
                    existing.item.rotation,
                    rotation,
                )
            {
                return Err(ProductServiceError::MutationIdConflict);
            }
            return Ok(PlacementMutationOutcome::Duplicate(existing.item));
        }

        if self.active_service.is_some() {
            return Err(ProductServiceError::ActiveServiceLayoutLocked);
        }

        let updated = self
            .restaurant
            .transform(catalog, instance_id, tile, rotation)
            .map_err(ProductServiceError::RestaurantAuthority)?;

        self.record_restaurant_mutation(
            mutation_id,
            RestaurantMutationOperation::Transform,
            updated,
        )?;
        Ok(PlacementMutationOutcome::Applied(updated))
    }

    pub fn remove_owned_item(
        &mut self,
        session: VerifiedProductSession,
        mutation_id: MutationId,
        instance_id: u64,
    ) -> Result<PlacementMutationOutcome, ProductServiceError> {
        self.require_subject(session)?;

        if self.floor_mutations.contains_key(&mutation_id)
            || self.wallpaper_mutations.contains_key(&mutation_id)
            || self.service_mutations.contains_key(&mutation_id)
        {
            return Err(ProductServiceError::MutationIdConflict);
        }
        if let Some(existing) = self.restaurant_mutations.get(&mutation_id) {
            if existing.operation != RestaurantMutationOperation::Remove
                || existing.item.instance_id != instance_id
            {
                return Err(ProductServiceError::MutationIdConflict);
            }
            return Ok(PlacementMutationOutcome::Duplicate(existing.item));
        }

        if self.active_service.is_some() {
            return Err(ProductServiceError::ActiveServiceLayoutLocked);
        }

        let removed = self
            .restaurant
            .remove(instance_id)
            .map_err(ProductServiceError::RestaurantAuthority)?;

        self.record_restaurant_mutation(mutation_id, RestaurantMutationOperation::Remove, removed)?;
        Ok(PlacementMutationOutcome::Applied(removed))
    }

    pub fn start_active_service(
        &mut self,
        session: VerifiedProductSession,
        catalog: &PlacementCatalog,
        mutation_id: MutationId,
        assignment: ActiveServiceAssignment,
    ) -> Result<ActiveServiceMutationOutcome, ProductServiceError> {
        self.require_subject(session)?;

        if self.restaurant_mutations.contains_key(&mutation_id)
            || self.floor_mutations.contains_key(&mutation_id)
            || self.wallpaper_mutations.contains_key(&mutation_id)
        {
            return Err(ProductServiceError::MutationIdConflict);
        }
        if let Some(existing) = self.service_mutations.get(&mutation_id) {
            return match existing.operation {
                ServiceMutationOperation::Start {
                    assignment: existing_assignment,
                    ..
                } if existing_assignment == assignment => {
                    Ok(ActiveServiceMutationOutcome::Duplicate(existing.result))
                }
                _ => Err(ProductServiceError::MutationIdConflict),
            };
        }
        if self.active_service.is_some() {
            return Err(ProductServiceError::ActiveServiceInProgress);
        }

        let restaurant_mutation_sequence = self
            .next_restaurant_mutation_sequence
            .checked_sub(1)
            .ok_or(ProductServiceError::Store(ProductStateStoreError::Corrupt))?;
        let service_id = self.next_service_id;
        let next_service_id = service_id
            .checked_add(1)
            .ok_or(ProductServiceError::ServiceIdExhausted)?;
        let started = ActiveServiceRecord::start(
            service_id,
            restaurant_mutation_sequence,
            assignment,
            &self.restaurant.snapshot(),
            catalog,
        )
        .map_err(ProductServiceError::ActiveServiceAuthority)?;

        self.record_service_mutation(
            mutation_id,
            ServiceMutationOperation::Start {
                restaurant_mutation_sequence,
                assignment,
                effective_at_ms: None,
            },
            Some(started),
        )?;
        self.active_service = Some(started);
        self.next_service_id = next_service_id;

        Ok(ActiveServiceMutationOutcome::Applied(Some(started)))
    }

    pub fn transition_active_service(
        &mut self,
        session: VerifiedProductSession,
        mutation_id: MutationId,
        service_id: u64,
        event: ServiceLoopEvent,
    ) -> Result<ActiveServiceMutationOutcome, ProductServiceError> {
        self.require_subject(session)?;

        if self.restaurant_mutations.contains_key(&mutation_id)
            || self.floor_mutations.contains_key(&mutation_id)
            || self.wallpaper_mutations.contains_key(&mutation_id)
        {
            return Err(ProductServiceError::MutationIdConflict);
        }
        if let Some(existing) = self.service_mutations.get(&mutation_id) {
            return match existing.operation {
                ServiceMutationOperation::Transition {
                    service_id: existing_service_id,
                    event: existing_event,
                    ..
                } if existing_service_id == service_id && existing_event == event => {
                    Ok(ActiveServiceMutationOutcome::Duplicate(existing.result))
                }
                _ => Err(ProductServiceError::MutationIdConflict),
            };
        }

        let current = self
            .active_service
            .ok_or(ProductServiceError::ActiveServiceNotFound)?;
        if current.identity.service_id != service_id {
            return Err(ProductServiceError::ActiveServiceIdMismatch);
        }
        let (transitioned, effect) = current
            .transition(event)
            .map_err(ProductServiceError::ServiceLoopAuthority)?;
        if effect.is_some() {
            return Err(ProductServiceError::MealSettlementNotConnected);
        }

        self.record_service_mutation(
            mutation_id,
            ServiceMutationOperation::Transition {
                service_id,
                event,
                effective_at_ms: None,
            },
            Some(transitioned),
        )?;
        self.active_service = Some(transitioned);

        Ok(ActiveServiceMutationOutcome::Applied(Some(transitioned)))
    }

    pub fn start_active_service_at(
        &mut self,
        session: VerifiedProductSession,
        catalog: &PlacementCatalog,
        mutation_id: MutationId,
        assignment: ActiveServiceAssignment,
        effective_at_ms: u64,
    ) -> Result<ActiveServiceMutationOutcome, ProductServiceError> {
        self.require_subject(session)?;

        if self.restaurant_mutations.contains_key(&mutation_id)
            || self.floor_mutations.contains_key(&mutation_id)
            || self.wallpaper_mutations.contains_key(&mutation_id)
        {
            return Err(ProductServiceError::MutationIdConflict);
        }
        if let Some(existing) = self.service_mutations.get(&mutation_id) {
            return match existing.operation {
                ServiceMutationOperation::Start {
                    assignment: existing_assignment,
                    ..
                } if existing_assignment == assignment => {
                    Ok(ActiveServiceMutationOutcome::Duplicate(existing.result))
                }
                _ => Err(ProductServiceError::MutationIdConflict),
            };
        }
        if self.active_service.is_some() {
            return Err(ProductServiceError::ActiveServiceInProgress);
        }

        let restaurant_mutation_sequence = self
            .next_restaurant_mutation_sequence
            .checked_sub(1)
            .ok_or(ProductServiceError::Store(ProductStateStoreError::Corrupt))?;
        let service_id = self.next_service_id;
        let next_service_id = service_id
            .checked_add(1)
            .ok_or(ProductServiceError::ServiceIdExhausted)?;
        let started = ActiveServiceRecord::start(
            service_id,
            restaurant_mutation_sequence,
            assignment,
            &self.restaurant.snapshot(),
            catalog,
        )
        .map_err(ProductServiceError::ActiveServiceAuthority)?
        .anchor_timing(effective_at_ms)
        .map_err(ProductServiceError::ServiceTimingAuthority)?;

        self.record_service_mutation(
            mutation_id,
            ServiceMutationOperation::Start {
                restaurant_mutation_sequence,
                assignment,
                effective_at_ms: Some(effective_at_ms),
            },
            Some(started),
        )?;
        self.active_service = Some(started);
        self.next_service_id = next_service_id;

        Ok(ActiveServiceMutationOutcome::Applied(Some(started)))
    }

    pub fn anchor_active_service_timing(
        &mut self,
        session: VerifiedProductSession,
        mutation_id: MutationId,
        service_id: u64,
        effective_at_ms: u64,
    ) -> Result<ActiveServiceMutationOutcome, ProductServiceError> {
        self.require_subject(session)?;

        if self.restaurant_mutations.contains_key(&mutation_id)
            || self.floor_mutations.contains_key(&mutation_id)
            || self.wallpaper_mutations.contains_key(&mutation_id)
        {
            return Err(ProductServiceError::MutationIdConflict);
        }
        if let Some(existing) = self.service_mutations.get(&mutation_id) {
            return match existing.operation {
                ServiceMutationOperation::AnchorTiming {
                    service_id: existing_service_id,
                    effective_at_ms: existing_at,
                } if existing_service_id == service_id && existing_at == effective_at_ms => {
                    Ok(ActiveServiceMutationOutcome::Duplicate(existing.result))
                }
                _ => Err(ProductServiceError::MutationIdConflict),
            };
        }

        let current = self
            .active_service
            .ok_or(ProductServiceError::ActiveServiceNotFound)?;
        if current.identity.service_id != service_id {
            return Err(ProductServiceError::ActiveServiceIdMismatch);
        }
        if current.timing_anchored {
            return Err(ProductServiceError::ServiceTimingAlreadyAnchored);
        }
        let anchored = current
            .anchor_timing(effective_at_ms)
            .map_err(ProductServiceError::ServiceTimingAuthority)?;

        self.record_service_mutation(
            mutation_id,
            ServiceMutationOperation::AnchorTiming {
                service_id,
                effective_at_ms,
            },
            Some(anchored),
        )?;
        self.active_service = Some(anchored);
        Ok(ActiveServiceMutationOutcome::Applied(Some(anchored)))
    }

    pub fn transition_active_service_at(
        &mut self,
        session: VerifiedProductSession,
        mutation_id: MutationId,
        service_id: u64,
        event: ServiceLoopEvent,
        effective_at_ms: u64,
    ) -> Result<ActiveServiceMutationOutcome, ProductServiceError> {
        self.require_subject(session)?;

        if self.restaurant_mutations.contains_key(&mutation_id)
            || self.floor_mutations.contains_key(&mutation_id)
            || self.wallpaper_mutations.contains_key(&mutation_id)
        {
            return Err(ProductServiceError::MutationIdConflict);
        }
        if let Some(existing) = self.service_mutations.get(&mutation_id) {
            return match existing.operation {
                ServiceMutationOperation::Transition {
                    service_id: existing_service_id,
                    event: existing_event,
                    ..
                } if existing_service_id == service_id && existing_event == event => {
                    Ok(ActiveServiceMutationOutcome::Duplicate(existing.result))
                }
                _ => Err(ProductServiceError::MutationIdConflict),
            };
        }

        let current = self
            .active_service
            .ok_or(ProductServiceError::ActiveServiceNotFound)?;
        if current.identity.service_id != service_id {
            return Err(ProductServiceError::ActiveServiceIdMismatch);
        }
        let (transitioned, effect) = current
            .transition_at(event, effective_at_ms)
            .map_err(ProductServiceError::ServiceTimingAuthority)?;
        if effect.is_some() {
            return Err(ProductServiceError::MealSettlementNotConnected);
        }

        self.record_service_mutation(
            mutation_id,
            ServiceMutationOperation::Transition {
                service_id,
                event,
                effective_at_ms: Some(effective_at_ms),
            },
            Some(transitioned),
        )?;
        self.active_service = Some(transitioned);

        Ok(ActiveServiceMutationOutcome::Applied(Some(transitioned)))
    }

    pub fn start_customer_chair_path(
        &mut self,
        session: VerifiedProductSession,
        catalog: &PlacementCatalog,
        mutation_id: MutationId,
        service_id: u64,
        start_tile: TilePoint,
        effective_at_ms: u64,
    ) -> Result<ActiveServiceMutationOutcome, ProductServiceError> {
        self.require_subject(session)?;

        if self.restaurant_mutations.contains_key(&mutation_id)
            || self.floor_mutations.contains_key(&mutation_id)
            || self.wallpaper_mutations.contains_key(&mutation_id)
        {
            return Err(ProductServiceError::MutationIdConflict);
        }
        if let Some(existing) = self.service_mutations.get(&mutation_id) {
            return match existing.operation {
                ServiceMutationOperation::StartCustomerChairPath {
                    service_id: existing_service_id,
                    start_tile: existing_start,
                    effective_at_ms: existing_at,
                } if existing_service_id == service_id
                    && existing_start == start_tile
                    && existing_at == effective_at_ms =>
                {
                    Ok(ActiveServiceMutationOutcome::Duplicate(existing.result))
                }
                _ => Err(ProductServiceError::MutationIdConflict),
            };
        }

        let current = self
            .active_service
            .ok_or(ProductServiceError::ActiveServiceNotFound)?;
        if current.identity.service_id != service_id {
            return Err(ProductServiceError::ActiveServiceIdMismatch);
        }
        if current.active_path.is_some() {
            return Err(ProductServiceError::ServicePathAuthority(
                ServicePathError::PathPlanMismatch,
            ));
        }

        let layout = derive_service_layout(&self.restaurant.snapshot(), catalog).map_err(|_| {
            ProductServiceError::ServicePathAuthority(ServicePathError::PathUnavailable)
        })?;
        let plan = plan_customer_path_to_chair(
            &layout,
            start_tile,
            current.identity.chair_instance_id,
            effective_at_ms,
        )
        .map_err(ProductServiceError::ServicePathAuthority)?;
        let (walking, effect) = current
            .transition_at(ServiceLoopEvent::StartChairWalk, effective_at_ms)
            .map_err(ProductServiceError::ServiceTimingAuthority)?;
        if effect.is_some() {
            return Err(ProductServiceError::Store(ProductStateStoreError::Corrupt));
        }
        let walking = ActiveServiceRecord {
            active_path: Some(plan),
            ..walking
        };

        self.record_service_mutation(
            mutation_id,
            ServiceMutationOperation::StartCustomerChairPath {
                service_id,
                start_tile,
                effective_at_ms,
            },
            Some(walking),
        )?;
        self.active_service = Some(walking);
        Ok(ActiveServiceMutationOutcome::Applied(Some(walking)))
    }

    pub fn complete_customer_chair_path(
        &mut self,
        session: VerifiedProductSession,
        catalog: &PlacementCatalog,
        mutation_id: MutationId,
        service_id: u64,
        effective_at_ms: u64,
    ) -> Result<ActiveServiceMutationOutcome, ProductServiceError> {
        self.require_subject(session)?;

        if self.restaurant_mutations.contains_key(&mutation_id)
            || self.floor_mutations.contains_key(&mutation_id)
            || self.wallpaper_mutations.contains_key(&mutation_id)
        {
            return Err(ProductServiceError::MutationIdConflict);
        }
        if let Some(existing) = self.service_mutations.get(&mutation_id) {
            return match existing.operation {
                ServiceMutationOperation::CompleteCustomerChairPath {
                    service_id: existing_service_id,
                    effective_at_ms: existing_at,
                } if existing_service_id == service_id && existing_at == effective_at_ms => {
                    Ok(ActiveServiceMutationOutcome::Duplicate(existing.result))
                }
                _ => Err(ProductServiceError::MutationIdConflict),
            };
        }

        let current = self
            .active_service
            .ok_or(ProductServiceError::ActiveServiceNotFound)?;
        if current.identity.service_id != service_id {
            return Err(ProductServiceError::ActiveServiceIdMismatch);
        }
        let plan = current.active_path.ok_or(ProductServiceError::ServicePathAuthority(
            ServicePathError::PathUnavailable,
        ))?;
        if plan.kind != ServicePathKind::CustomerToChair
            || effective_at_ms != plan.completes_at_ms
        {
            return Err(ProductServiceError::ServicePathAuthority(
                ServicePathError::PathCompletionTimeMismatch,
            ));
        }

        let layout = derive_service_layout(&self.restaurant.snapshot(), catalog).map_err(|_| {
            ProductServiceError::ServicePathAuthority(ServicePathError::PathUnavailable)
        })?;
        validate_customer_path_to_chair_plan(
            &layout,
            current.identity.chair_instance_id,
            plan,
        )
        .map_err(ProductServiceError::ServicePathAuthority)?;

        let (deciding, effect) = current
            .transition_at(ServiceLoopEvent::ReachChair, effective_at_ms)
            .map_err(ProductServiceError::ServiceTimingAuthority)?;
        if effect.is_some() {
            return Err(ProductServiceError::Store(ProductStateStoreError::Corrupt));
        }
        let deciding = ActiveServiceRecord {
            active_path: None,
            ..deciding
        };

        self.record_service_mutation(
            mutation_id,
            ServiceMutationOperation::CompleteCustomerChairPath {
                service_id,
                effective_at_ms,
            },
            Some(deciding),
        )?;
        self.active_service = Some(deciding);
        Ok(ActiveServiceMutationOutcome::Applied(Some(deciding)))
    }

    pub fn complete_active_service(
        &mut self,
        session: VerifiedProductSession,
        mutation_id: MutationId,
        service_id: u64,
    ) -> Result<ActiveServiceMutationOutcome, ProductServiceError> {
        self.require_subject(session)?;

        if self.restaurant_mutations.contains_key(&mutation_id)
            || self.floor_mutations.contains_key(&mutation_id)
            || self.wallpaper_mutations.contains_key(&mutation_id)
        {
            return Err(ProductServiceError::MutationIdConflict);
        }
        if let Some(existing) = self.service_mutations.get(&mutation_id) {
            return match existing.operation {
                ServiceMutationOperation::Complete {
                    service_id: existing_service_id,
                } if existing_service_id == service_id => {
                    Ok(ActiveServiceMutationOutcome::Duplicate(existing.result))
                }
                _ => Err(ProductServiceError::MutationIdConflict),
            };
        }

        let current = self
            .active_service
            .ok_or(ProductServiceError::ActiveServiceNotFound)?;
        if current.identity.service_id != service_id {
            return Err(ProductServiceError::ActiveServiceIdMismatch);
        }
        if current.state.customer != CustomerServiceState::Left
            || current.state.order != OrderServiceState::Settled
        {
            return Err(ProductServiceError::ActiveServiceNotComplete);
        }

        self.record_service_mutation(
            mutation_id,
            ServiceMutationOperation::Complete { service_id },
            None,
        )?;
        self.active_service = None;

        Ok(ActiveServiceMutationOutcome::Applied(None))
    }

    fn record_service_mutation(
        &mut self,
        mutation_id: MutationId,
        operation: ServiceMutationOperation,
        result: Option<ActiveServiceRecord>,
    ) -> Result<(), ProductServiceError> {
        let sequence = self.next_service_mutation_sequence;
        let next_sequence = sequence
            .checked_add(1)
            .ok_or(ProductServiceError::ServiceMutationSequenceExhausted)?;

        if self
            .service_mutations
            .insert(
                mutation_id,
                ServiceMutationRecord {
                    sequence,
                    operation,
                    result,
                },
            )
            .is_some()
        {
            return Err(ProductServiceError::Store(ProductStateStoreError::Corrupt));
        }
        self.next_service_mutation_sequence = next_sequence;
        Ok(())
    }

    fn record_restaurant_mutation(
        &mut self,
        mutation_id: MutationId,
        operation: RestaurantMutationOperation,
        item: PlacedItem,
    ) -> Result<(), ProductServiceError> {
        let sequence = self.next_restaurant_mutation_sequence;
        let next_sequence = sequence
            .checked_add(1)
            .ok_or(ProductServiceError::RestaurantMutationSequenceExhausted)?;

        if self
            .restaurant_mutations
            .insert(
                mutation_id,
                RestaurantMutationRecord {
                    sequence,
                    operation,
                    item,
                },
            )
            .is_some()
        {
            return Err(ProductServiceError::Store(ProductStateStoreError::Corrupt));
        }

        self.next_restaurant_mutation_sequence = next_sequence;
        Ok(())
    }

    fn record_wallpaper_mutation(
        &mut self,
        mutation_id: MutationId,
        operation: WallpaperMutationOperation,
        wallpaper: AppliedWallpaper,
    ) -> Result<(), ProductServiceError> {
        let sequence = self.next_wallpaper_mutation_sequence;
        let next_sequence = sequence
            .checked_add(1)
            .ok_or(ProductServiceError::WallpaperMutationSequenceExhausted)?;

        if self
            .wallpaper_mutations
            .insert(
                mutation_id,
                WallpaperMutationRecord {
                    sequence,
                    operation,
                    wallpaper,
                },
            )
            .is_some()
        {
            return Err(ProductServiceError::Store(ProductStateStoreError::Corrupt));
        }

        self.next_wallpaper_mutation_sequence = next_sequence;
        Ok(())
    }

    fn record_floor_mutation(
        &mut self,
        mutation_id: MutationId,
        tile: PaintedFloorTile,
    ) -> Result<(), ProductServiceError> {
        let sequence = self.next_floor_mutation_sequence;
        let next_sequence = sequence
            .checked_add(1)
            .ok_or(ProductServiceError::FloorMutationSequenceExhausted)?;

        if self
            .floor_mutations
            .insert(mutation_id, FloorTileMutationRecord { sequence, tile })
            .is_some()
        {
            return Err(ProductServiceError::Store(ProductStateStoreError::Corrupt));
        }
        self.next_floor_mutation_sequence = next_sequence;
        Ok(())
    }

    fn placed_count_for_item(&self, item_id: u32) -> Result<u32, ProductServiceError> {
        let object_count = self
            .restaurant
            .items()
            .filter(|item| item.item_id == item_id)
            .count();
        let floor_count = self
            .floor_tiles
            .values()
            .filter(|tile| tile.item_id == item_id)
            .count();
        let wallpaper_count = self
            .wallpapers
            .values()
            .filter(|wallpaper| wallpaper.item_id == item_id)
            .count();
        let total = object_count
            .checked_add(floor_count)
            .and_then(|value| value.checked_add(wallpaper_count))
            .ok_or(ProductServiceError::Store(ProductStateStoreError::Corrupt))?;
        u32::try_from(total)
            .map_err(|_| ProductServiceError::Store(ProductStateStoreError::Corrupt))
    }

    pub fn restaurant_product_snapshot(
        &self,
        session: VerifiedProductSession,
    ) -> Result<RestaurantProductSnapshot, ProductServiceError> {
        self.require_subject(session)?;

        let restaurant = self.restaurant.snapshot();
        let floor_tiles: Vec<_> = self.floor_tiles.values().copied().collect();
        let wallpapers: Vec<_> = self.wallpapers.values().copied().collect();
        let mut placed_counts = BTreeMap::<u32, u32>::new();
        for item in &restaurant.items {
            let count = placed_counts.entry(item.item_id).or_default();
            *count = count
                .checked_add(1)
                .ok_or(ProductServiceError::Store(ProductStateStoreError::Corrupt))?;
        }
        for tile in &floor_tiles {
            let count = placed_counts.entry(tile.item_id).or_default();
            *count = count
                .checked_add(1)
                .ok_or(ProductServiceError::Store(ProductStateStoreError::Corrupt))?;
        }
        for wallpaper in &wallpapers {
            let count = placed_counts.entry(wallpaper.item_id).or_default();
            *count = count
                .checked_add(1)
                .ok_or(ProductServiceError::Store(ProductStateStoreError::Corrupt))?;
        }

        let mut inventory = Vec::new();
        for (item_id, owned) in self.player.inventory().entries() {
            let placed = placed_counts.get(&item_id).copied().unwrap_or(0);
            let available = owned
                .checked_sub(placed)
                .ok_or(ProductServiceError::Store(ProductStateStoreError::Corrupt))?;
            inventory.push(InventoryAvailability {
                item_id,
                owned,
                placed,
                available,
            });
        }

        if placed_counts
            .keys()
            .any(|item_id| self.player.inventory().quantity(*item_id) == 0)
        {
            return Err(ProductServiceError::Store(ProductStateStoreError::Corrupt));
        }

        Ok(RestaurantProductSnapshot {
            restaurant,
            floor_tiles,
            wallpapers,
            inventory,
        })
    }

    fn require_subject(&self, session: VerifiedProductSession) -> Result<(), ProductServiceError> {
        if session.subject != self.subject() {
            return Err(ProductServiceError::SubjectMismatch);
        }
        Ok(())
    }
}

fn mutation_rotation_matches(
    catalog: &PlacementCatalog,
    item_id: u32,
    authoritative_rotation: u8,
    requested_rotation: u8,
) -> bool {
    match catalog.get(item_id) {
        Some(definition) if definition.flags.wall_decoration_item => true,
        Some(_) => authoritative_rotation == requested_rotation,
        None => false,
    }
}

fn restaurant_snapshots_match_content(
    left: &RestaurantSnapshot,
    right: &RestaurantSnapshot,
) -> bool {
    if left.room != right.room || left.next_instance_id != right.next_instance_id {
        return false;
    }

    let left_items: BTreeMap<_, _> = left
        .items
        .iter()
        .map(|item| (item.instance_id, *item))
        .collect();
    let right_items: BTreeMap<_, _> = right
        .items
        .iter()
        .map(|item| (item.instance_id, *item))
        .collect();

    left_items.len() == left.items.len()
        && right_items.len() == right.items.len()
        && left_items == right_items
}

impl From<RoomDimensions> for PersistedRoom {
    fn from(value: RoomDimensions) -> Self {
        Self {
            inside_x: value.inside_x,
            inside_y: value.inside_y,
            outside_x: value.outside_x,
            outside_y: value.outside_y,
        }
    }
}

impl From<PersistedRoom> for RoomDimensions {
    fn from(value: PersistedRoom) -> Self {
        Self {
            inside_x: value.inside_x,
            inside_y: value.inside_y,
            outside_x: value.outside_x,
            outside_y: value.outside_y,
        }
    }
}

impl From<PlacedItem> for PersistedPlacedItem {
    fn from(value: PlacedItem) -> Self {
        Self {
            instance_id: value.instance_id,
            item_id: value.item_id,
            tile_x: value.tile.x,
            tile_y: value.tile.y,
            rotation: value.rotation,
            room_index: value.room_index,
        }
    }
}

impl From<PersistedPlacedItem> for PlacedItem {
    fn from(value: PersistedPlacedItem) -> Self {
        Self {
            instance_id: value.instance_id,
            item_id: value.item_id,
            tile: TilePoint {
                x: value.tile_x,
                y: value.tile_y,
            },
            rotation: value.rotation,
            room_index: value.room_index,
        }
    }
}

impl From<PaintedFloorTile> for PersistedFloorTile {
    fn from(value: PaintedFloorTile) -> Self {
        Self {
            item_id: value.item_id,
            tile_x: value.tile.x,
            tile_y: value.tile.y,
            room_index: value.room_index,
        }
    }
}

impl From<PersistedFloorTile> for PaintedFloorTile {
    fn from(value: PersistedFloorTile) -> Self {
        Self {
            item_id: value.item_id,
            tile: TilePoint {
                x: value.tile_x,
                y: value.tile_y,
            },
            room_index: value.room_index,
        }
    }
}

impl From<AppliedWallpaper> for PersistedWallpaper {
    fn from(value: AppliedWallpaper) -> Self {
        Self {
            item_id: value.item_id,
            rotation: value.orientation.rotation(),
        }
    }
}

impl TryFrom<PersistedWallpaper> for AppliedWallpaper {
    type Error = ();

    fn try_from(value: PersistedWallpaper) -> Result<Self, Self::Error> {
        let orientation = WallpaperOrientation::from_rotation(value.rotation).ok_or(())?;
        Ok(Self {
            item_id: value.item_id,
            orientation,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoadedProductState {
    pub store_revision: u64,
    pub state: ProductAggregate,
}

pub trait ProductStateStore: Send + Sync {
    fn load(
        &self,
        subject: AnewSubject,
    ) -> Result<Option<LoadedProductState>, ProductStateStoreError>;

    fn compare_and_swap(
        &self,
        subject: AnewSubject,
        expected_revision: Option<u64>,
        state: ProductAggregate,
    ) -> Result<u64, ProductStateStoreError>;
}

#[derive(Clone, Debug, Default)]
pub struct InMemoryProductStateStore {
    states: Arc<Mutex<BTreeMap<AnewSubject, (u64, ProductAggregate)>>>,
}

impl ProductStateStore for InMemoryProductStateStore {
    fn load(
        &self,
        subject: AnewSubject,
    ) -> Result<Option<LoadedProductState>, ProductStateStoreError> {
        let states = self
            .states
            .lock()
            .map_err(|_| ProductStateStoreError::Unavailable)?;
        Ok(states
            .get(&subject)
            .map(|(store_revision, state)| LoadedProductState {
                store_revision: *store_revision,
                state: state.clone(),
            }))
    }

    fn compare_and_swap(
        &self,
        subject: AnewSubject,
        expected_revision: Option<u64>,
        state: ProductAggregate,
    ) -> Result<u64, ProductStateStoreError> {
        if state.subject() != subject {
            return Err(ProductStateStoreError::Corrupt);
        }

        let mut states = self
            .states
            .lock()
            .map_err(|_| ProductStateStoreError::Unavailable)?;
        let current_revision = states.get(&subject).map(|(revision, _)| *revision);
        if current_revision != expected_revision {
            return Err(ProductStateStoreError::Conflict);
        }

        let next_revision = current_revision
            .unwrap_or(0)
            .checked_add(1)
            .ok_or(ProductStateStoreError::Corrupt)?;
        states.insert(subject, (next_revision, state));
        Ok(next_revision)
    }
}

pub struct RestaurantProductService<V, S> {
    verifier: V,
    store: S,
    catalog: PlacementCatalog,
    initial_room: RoomDimensions,
    clock: Arc<dyn ServiceTimeSource>,
}

impl<V, S> RestaurantProductService<V, S>
where
    V: PlatformSessionVerifier,
    S: ProductStateStore,
{
    pub fn new(
        verifier: V,
        store: S,
        catalog: PlacementCatalog,
        initial_room: RoomDimensions,
    ) -> Self {
        Self::new_with_clock(
            verifier,
            store,
            catalog,
            initial_room,
            Arc::new(SystemServiceTimeSource),
        )
    }

    pub fn new_with_clock(
        verifier: V,
        store: S,
        catalog: PlacementCatalog,
        initial_room: RoomDimensions,
        clock: Arc<dyn ServiceTimeSource>,
    ) -> Self {
        Self {
            verifier,
            store,
            catalog,
            initial_room,
            clock,
        }
    }

    pub fn apply_player_command(
        &self,
        session_token: &str,
        mutation_id: MutationId,
        command: Command,
    ) -> Result<MutationOutcome, ProductServiceError> {
        let session = self.verify(session_token)?;

        for _ in 0..MAX_STORE_RETRIES {
            let (expected_revision, mut state) = self.load_or_initialize(session.subject)?;
            let outcome =
                state.apply_player_command(session, mutation_id.clone(), command.clone())?;

            if matches!(outcome, MutationOutcome::Duplicate { .. }) {
                return Ok(outcome);
            }

            match self
                .store
                .compare_and_swap(session.subject, expected_revision, state)
            {
                Ok(_) => return Ok(outcome),
                Err(ProductStateStoreError::Conflict) => continue,
                Err(error) => return Err(ProductServiceError::Store(error)),
            }
        }

        Err(ProductServiceError::StoreConflict)
    }

    pub fn place_item(
        &self,
        session_token: &str,
        mutation_id: MutationId,
        intent: PlacementIntent,
    ) -> Result<PlacementMutationOutcome, ProductServiceError> {
        let session = self.verify(session_token)?;

        for _ in 0..MAX_STORE_RETRIES {
            let (expected_revision, mut state) = self.load_or_initialize(session.subject)?;
            let outcome =
                state.place_owned_item(session, &self.catalog, mutation_id.clone(), intent)?;

            if matches!(outcome, PlacementMutationOutcome::Duplicate(_)) {
                return Ok(outcome);
            }

            match self
                .store
                .compare_and_swap(session.subject, expected_revision, state)
            {
                Ok(_) => return Ok(outcome),
                Err(ProductStateStoreError::Conflict) => continue,
                Err(error) => return Err(ProductServiceError::Store(error)),
            }
        }

        Err(ProductServiceError::StoreConflict)
    }

    pub fn paint_floor_tile(
        &self,
        session_token: &str,
        mutation_id: MutationId,
        intent: FloorTileIntent,
    ) -> Result<FloorTileMutationOutcome, ProductServiceError> {
        let session = self.verify(session_token)?;

        for _ in 0..MAX_STORE_RETRIES {
            let (expected_revision, mut state) = self.load_or_initialize(session.subject)?;
            let outcome = state.paint_owned_floor_tile(
                session,
                &self.catalog,
                mutation_id.clone(),
                intent,
            )?;

            if matches!(outcome, FloorTileMutationOutcome::Duplicate(_)) {
                return Ok(outcome);
            }

            match self
                .store
                .compare_and_swap(session.subject, expected_revision, state)
            {
                Ok(_) => return Ok(outcome),
                Err(ProductStateStoreError::Conflict) => continue,
                Err(error) => return Err(ProductServiceError::Store(error)),
            }
        }

        Err(ProductServiceError::StoreConflict)
    }

    pub fn apply_wallpaper(
        &self,
        session_token: &str,
        mutation_id: MutationId,
        intent: WallpaperIntent,
    ) -> Result<WallpaperMutationOutcome, ProductServiceError> {
        let session = self.verify(session_token)?;

        for _ in 0..MAX_STORE_RETRIES {
            let (expected_revision, mut state) = self.load_or_initialize(session.subject)?;
            let outcome =
                state.apply_owned_wallpaper(session, &self.catalog, mutation_id.clone(), intent)?;

            if matches!(outcome, WallpaperMutationOutcome::Duplicate(_)) {
                return Ok(outcome);
            }

            match self
                .store
                .compare_and_swap(session.subject, expected_revision, state)
            {
                Ok(_) => return Ok(outcome),
                Err(ProductStateStoreError::Conflict) => continue,
                Err(error) => return Err(ProductServiceError::Store(error)),
            }
        }

        Err(ProductServiceError::StoreConflict)
    }

    pub fn remove_wallpaper(
        &self,
        session_token: &str,
        mutation_id: MutationId,
        orientation: WallpaperOrientation,
    ) -> Result<WallpaperMutationOutcome, ProductServiceError> {
        let session = self.verify(session_token)?;

        for _ in 0..MAX_STORE_RETRIES {
            let (expected_revision, mut state) = self.load_or_initialize(session.subject)?;
            let outcome =
                state.remove_owned_wallpaper(session, mutation_id.clone(), orientation)?;

            if matches!(outcome, WallpaperMutationOutcome::Duplicate(_)) {
                return Ok(outcome);
            }

            match self
                .store
                .compare_and_swap(session.subject, expected_revision, state)
            {
                Ok(_) => return Ok(outcome),
                Err(ProductStateStoreError::Conflict) => continue,
                Err(error) => return Err(ProductServiceError::Store(error)),
            }
        }

        Err(ProductServiceError::StoreConflict)
    }

    pub fn transform_item(
        &self,
        session_token: &str,
        mutation_id: MutationId,
        instance_id: u64,
        tile: TilePoint,
        rotation: u8,
    ) -> Result<PlacementMutationOutcome, ProductServiceError> {
        let session = self.verify(session_token)?;

        for _ in 0..MAX_STORE_RETRIES {
            let (expected_revision, mut state) = self.load_or_initialize(session.subject)?;
            let outcome = state.transform_owned_item(
                session,
                &self.catalog,
                mutation_id.clone(),
                instance_id,
                tile,
                rotation,
            )?;

            if matches!(outcome, PlacementMutationOutcome::Duplicate(_)) {
                return Ok(outcome);
            }

            match self
                .store
                .compare_and_swap(session.subject, expected_revision, state)
            {
                Ok(_) => return Ok(outcome),
                Err(ProductStateStoreError::Conflict) => continue,
                Err(error) => return Err(ProductServiceError::Store(error)),
            }
        }

        Err(ProductServiceError::StoreConflict)
    }

    pub fn remove_item(
        &self,
        session_token: &str,
        mutation_id: MutationId,
        instance_id: u64,
    ) -> Result<PlacementMutationOutcome, ProductServiceError> {
        let session = self.verify(session_token)?;

        for _ in 0..MAX_STORE_RETRIES {
            let (expected_revision, mut state) = self.load_or_initialize(session.subject)?;
            let outcome = state.remove_owned_item(session, mutation_id.clone(), instance_id)?;

            if matches!(outcome, PlacementMutationOutcome::Duplicate(_)) {
                return Ok(outcome);
            }

            match self
                .store
                .compare_and_swap(session.subject, expected_revision, state)
            {
                Ok(_) => return Ok(outcome),
                Err(ProductStateStoreError::Conflict) => continue,
                Err(error) => return Err(ProductServiceError::Store(error)),
            }
        }

        Err(ProductServiceError::StoreConflict)
    }

    pub fn start_active_service(
        &self,
        session_token: &str,
        mutation_id: MutationId,
        assignment: ActiveServiceAssignment,
    ) -> Result<ActiveServiceMutationOutcome, ProductServiceError> {
        let session = self.verify(session_token)?;

        for _ in 0..MAX_STORE_RETRIES {
            let (expected_revision, mut state) = self.load_or_initialize(session.subject)?;
            let effective_at_ms = self
                .clock
                .now_ms()
                .map_err(ProductServiceError::ServiceTimingAuthority)?;
            let outcome = state.start_active_service_at(
                session,
                &self.catalog,
                mutation_id.clone(),
                assignment,
                effective_at_ms,
            )?;

            if matches!(outcome, ActiveServiceMutationOutcome::Duplicate(_)) {
                return Ok(outcome);
            }

            match self
                .store
                .compare_and_swap(session.subject, expected_revision, state)
            {
                Ok(_) => return Ok(outcome),
                Err(ProductStateStoreError::Conflict) => continue,
                Err(error) => return Err(ProductServiceError::Store(error)),
            }
        }

        Err(ProductServiceError::StoreConflict)
    }

    pub fn transition_active_service(
        &self,
        session_token: &str,
        mutation_id: MutationId,
        service_id: u64,
        event: ServiceLoopEvent,
    ) -> Result<ActiveServiceMutationOutcome, ProductServiceError> {
        let session = self.verify(session_token)?;

        for _ in 0..MAX_STORE_RETRIES {
            let (expected_revision, mut state) = self.load_or_initialize(session.subject)?;
            let effective_at_ms = self
                .clock
                .now_ms()
                .map_err(ProductServiceError::ServiceTimingAuthority)?;
            let outcome = state.transition_active_service_at(
                session,
                mutation_id.clone(),
                service_id,
                event,
                effective_at_ms,
            )?;

            if matches!(outcome, ActiveServiceMutationOutcome::Duplicate(_)) {
                return Ok(outcome);
            }

            match self
                .store
                .compare_and_swap(session.subject, expected_revision, state)
            {
                Ok(_) => return Ok(outcome),
                Err(ProductStateStoreError::Conflict) => continue,
                Err(error) => return Err(ProductServiceError::Store(error)),
            }
        }

        Err(ProductServiceError::StoreConflict)
    }

    pub fn complete_active_service(
        &self,
        session_token: &str,
        mutation_id: MutationId,
        service_id: u64,
    ) -> Result<ActiveServiceMutationOutcome, ProductServiceError> {
        let session = self.verify(session_token)?;

        for _ in 0..MAX_STORE_RETRIES {
            let (expected_revision, mut state) = self.load_or_initialize(session.subject)?;
            let outcome =
                state.complete_active_service(session, mutation_id.clone(), service_id)?;

            if matches!(outcome, ActiveServiceMutationOutcome::Duplicate(_)) {
                return Ok(outcome);
            }

            match self
                .store
                .compare_and_swap(session.subject, expected_revision, state)
            {
                Ok(_) => return Ok(outcome),
                Err(ProductStateStoreError::Conflict) => continue,
                Err(error) => return Err(ProductServiceError::Store(error)),
            }
        }

        Err(ProductServiceError::StoreConflict)
    }

    pub fn load_active_service(
        &self,
        session_token: &str,
    ) -> Result<Option<ActiveServiceRecord>, ProductServiceError> {
        Ok(self.load_active_service_read(session_token)?.active)
    }

    pub fn load_active_service_read(
        &self,
        session_token: &str,
    ) -> Result<ActiveServiceReadSnapshot, ProductServiceError> {
        let session = self.verify(session_token)?;

        for _ in 0..MAX_STORE_RETRIES {
            let loaded = self
                .store
                .load(session.subject)
                .map_err(ProductServiceError::Store)?;
            let now_ms = self
                .clock
                .now_ms()
                .map_err(ProductServiceError::ServiceTimingAuthority)?;
            let Some(loaded) = loaded else {
                return Ok(ActiveServiceReadSnapshot {
                    server_now_ms: now_ms,
                    active: None,
                });
            };
            let expected_revision = Some(loaded.store_revision);
            let mut state = loaded.state;
            state.require_subject(session)?;

            let Some(mut active) = state.active_service() else {
                return Ok(ActiveServiceReadSnapshot {
                    server_now_ms: now_ms,
                    active: None,
                });
            };
            let mut changed = false;

            if !active.timing_anchored {
                let mutation_id = internal_service_mutation_id(
                    "anchor",
                    active.identity.service_id,
                    now_ms,
                    None,
                )?;
                let outcome = state.anchor_active_service_timing(
                    session,
                    mutation_id,
                    active.identity.service_id,
                    now_ms,
                )?;
                active = outcome
                    .record()
                    .ok_or(ProductServiceError::Store(ProductStateStoreError::Corrupt))?;
                changed = true;
            }

            for _ in 0..8 {
                let Some(due) = due_service_event(active.state, active.deadlines, now_ms)
                    .map_err(ProductServiceError::ServiceTimingAuthority)?
                else {
                    break;
                };
                let mutation_id = internal_service_mutation_id(
                    "timer",
                    active.identity.service_id,
                    due.effective_at_ms,
                    Some(due.event),
                )?;
                let outcome = state.transition_active_service_at(
                    session,
                    mutation_id,
                    active.identity.service_id,
                    due.event,
                    due.effective_at_ms,
                )?;
                active = outcome
                    .record()
                    .ok_or(ProductServiceError::Store(ProductStateStoreError::Corrupt))?;
                changed = true;
            }

            if due_service_event(active.state, active.deadlines, now_ms)
                .map_err(ProductServiceError::ServiceTimingAuthority)?
                .is_some()
            {
                return Err(ProductServiceError::ServiceTimingAuthority(
                    ServiceTimingError::CatchUpLoop,
                ));
            }

            if !changed {
                return Ok(ActiveServiceReadSnapshot {
                    server_now_ms: now_ms,
                    active: Some(active),
                });
            }

            match self
                .store
                .compare_and_swap(session.subject, expected_revision, state)
            {
                Ok(_) => {
                    return Ok(ActiveServiceReadSnapshot {
                        server_now_ms: now_ms,
                        active: Some(active),
                    });
                }
                Err(ProductStateStoreError::Conflict) => continue,
                Err(error) => return Err(ProductServiceError::Store(error)),
            }
        }

        Err(ProductServiceError::StoreConflict)
    }

    pub fn load_restaurant(
        &self,
        session_token: &str,
    ) -> Result<RestaurantProductSnapshot, ProductServiceError> {
        let session = self.verify(session_token)?;
        let state = self
            .store
            .load(session.subject)
            .map_err(ProductServiceError::Store)?
            .map(|loaded| loaded.state)
            .unwrap_or_else(|| ProductAggregate::new(session.subject, self.initial_room));
        state.restaurant_product_snapshot(session)
    }

    pub fn load_restaurant_with_topology(
        &self,
        session_token: &str,
    ) -> Result<(RestaurantProductSnapshot, ServiceLayoutSnapshot), ProductServiceError> {
        let session = self.verify(session_token)?;
        let state = self
            .store
            .load(session.subject)
            .map_err(ProductServiceError::Store)?
            .map(|loaded| loaded.state)
            .unwrap_or_else(|| ProductAggregate::new(session.subject, self.initial_room));
        let snapshot = state.restaurant_product_snapshot(session)?;
        let topology = derive_service_layout(&snapshot.restaurant, &self.catalog)
            .map_err(|_| ProductServiceError::Store(ProductStateStoreError::Corrupt))?;
        Ok((snapshot, topology))
    }

    pub fn into_store(self) -> S {
        self.store
    }

    fn verify(&self, session_token: &str) -> Result<VerifiedProductSession, ProductServiceError> {
        self.verifier
            .verify_product_session(session_token)
            .map_err(ProductServiceError::Session)
    }

    fn load_or_initialize(
        &self,
        subject: AnewSubject,
    ) -> Result<(Option<u64>, ProductAggregate), ProductServiceError> {
        Ok(
            match self
                .store
                .load(subject)
                .map_err(ProductServiceError::Store)?
            {
                Some(loaded) => (Some(loaded.store_revision), loaded.state),
                None => (None, ProductAggregate::new(subject, self.initial_room)),
            },
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProductStateStoreError {
    Unavailable,
    Corrupt,
    Conflict,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProductServiceError {
    Session(PlatformSessionError),
    Store(ProductStateStoreError),
    StoreConflict,
    SubjectMismatch,
    PlayerAuthority(AuthorityError),
    RestaurantAuthority(RestaurantAuthorityError),
    ActiveServiceAuthority(ActiveServiceError),
    ServiceLoopAuthority(ServiceLoopError),
    ServiceTimingAuthority(ServiceTimingError),
    ServicePathAuthority(ServicePathError),
    ItemUnavailable {
        item_id: u32,
        owned: u32,
        placed: u32,
    },
    MutationIdConflict,
    ActiveServiceInProgress,
    ActiveServiceLayoutLocked,
    ActiveServiceNotFound,
    ActiveServiceIdMismatch,
    ActiveServiceNotComplete,
    ServiceTimingAlreadyAnchored,
    MealSettlementNotConnected,
    WallpaperNotApplied {
        rotation: u8,
    },
    RestaurantMutationSequenceExhausted,
    FloorMutationSequenceExhausted,
    WallpaperMutationSequenceExhausted,
    ServiceMutationSequenceExhausted,
    ServiceIdExhausted,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Command;
    use crate::placement::{Footprint, PlacementFlags, TilePoint};
    use crate::platform::{PRODUCT_ID, ProductSessionId};
    use crate::restaurant::ItemPlacementDefinition;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[derive(Clone)]
    struct FakeServiceClock {
        now_ms: Arc<AtomicU64>,
    }

    impl FakeServiceClock {
        fn new(now_ms: u64) -> Self {
            Self {
                now_ms: Arc::new(AtomicU64::new(now_ms)),
            }
        }

        fn set(&self, now_ms: u64) {
            self.now_ms.store(now_ms, Ordering::SeqCst);
        }
    }

    impl ServiceTimeSource for FakeServiceClock {
        fn now_ms(&self) -> Result<u64, ServiceTimingError> {
            Ok(self.now_ms.load(Ordering::SeqCst))
        }
    }

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
            if session_token != "valid-product-session" {
                return Err(PlatformSessionError::Invalid);
            }
            let _ = PRODUCT_ID;
            Ok(VerifiedProductSession {
                subject: self.subject,
                session_id: self.session_id,
            })
        }
    }

    fn subject(value: u8) -> AnewSubject {
        AnewSubject::from_verified_platform_bytes([value; 16]).unwrap()
    }

    fn mutation(value: &str) -> MutationId {
        MutationId::new(value.to_owned()).unwrap()
    }

    fn catalog() -> PlacementCatalog {
        PlacementCatalog::new([ItemPlacementDefinition {
            item_id: 10,
            footprint: Footprint {
                size_x: 2,
                size_y: 1,
            },
            rotation_count: 4,
            flags: PlacementFlags::default(),
        }])
        .unwrap()
    }

    fn room() -> RoomDimensions {
        RoomDimensions {
            inside_x: 8,
            inside_y: 8,
            outside_x: 0,
            outside_y: 0,
        }
    }

    fn wall_catalog() -> PlacementCatalog {
        PlacementCatalog::new([ItemPlacementDefinition {
            item_id: 60,
            footprint: Footprint {
                size_x: 1,
                size_y: 1,
            },
            rotation_count: 2,
            flags: PlacementFlags {
                wall_decoration_item: true,
                ..PlacementFlags::default()
            },
        }])
        .unwrap()
    }

    fn door_catalog() -> PlacementCatalog {
        PlacementCatalog::new([ItemPlacementDefinition {
            item_id: 3_010_000,
            footprint: Footprint {
                size_x: 1,
                size_y: 1,
            },
            rotation_count: 2,
            flags: PlacementFlags {
                wall_decoration_item: true,
                ..PlacementFlags::default()
            },
        }])
        .unwrap()
    }

    fn wallpaper_catalog() -> PlacementCatalog {
        PlacementCatalog::new([
            ItemPlacementDefinition {
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
            },
            ItemPlacementDefinition {
                item_id: 3_060_001,
                footprint: Footprint {
                    size_x: 1,
                    size_y: 1,
                },
                rotation_count: 2,
                flags: PlacementFlags {
                    wallpaper_item: true,
                    ..PlacementFlags::default()
                },
            },
        ])
        .unwrap()
    }

    fn floor_catalog() -> PlacementCatalog {
        PlacementCatalog::new([
            ItemPlacementDefinition {
                item_id: 30,
                footprint: Footprint {
                    size_x: 1,
                    size_y: 1,
                },
                rotation_count: 1,
                flags: PlacementFlags {
                    floor_tile_item: true,
                    ..PlacementFlags::default()
                },
            },
            ItemPlacementDefinition {
                item_id: 31,
                footprint: Footprint {
                    size_x: 1,
                    size_y: 1,
                },
                rotation_count: 1,
                flags: PlacementFlags {
                    floor_tile_item: true,
                    ..PlacementFlags::default()
                },
            },
        ])
        .unwrap()
    }

    fn floor_service() -> RestaurantProductService<FakeVerifier, InMemoryProductStateStore> {
        let verifier = FakeVerifier {
            subject: subject(7),
            session_id: ProductSessionId::from_verified_platform_bytes([9; 16]).unwrap(),
        };
        RestaurantProductService::new(
            verifier,
            InMemoryProductStateStore::default(),
            floor_catalog(),
            room(),
        )
    }

    fn service() -> RestaurantProductService<FakeVerifier, InMemoryProductStateStore> {
        let verifier = FakeVerifier {
            subject: subject(7),
            session_id: ProductSessionId::from_verified_platform_bytes([9; 16]).unwrap(),
        };

        RestaurantProductService::new(
            verifier,
            InMemoryProductStateStore::default(),
            catalog(),
            room(),
        )
    }

    fn active_service_catalog() -> PlacementCatalog {
        PlacementCatalog::from_trusted_tsv(concat!(
            "ANEWON_RC_PLACEMENT_CATALOG_V4\n",
            "item_id\tsize_x\tsize_y\trotation_count\twall_item\twall_decoration_item\twallpaper_item\toutdoor\tfloor_tile_item\tsurface\tstackable\tdoor_item\tchair_item\ttable_item\tkitchen\tdrink\ttoilet\toccupied_cells\n",
            "11\t1\t1\t4\t0\t0\t0\t0\t0\t0\t0\t0\t1\t0\t0\t0\t0\t-\n",
            "12\t1\t1\t4\t0\t0\t0\t0\t0\t0\t0\t0\t0\t1\t0\t0\t0\t-\n",
            "13\t2\t1\t4\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0\t1\t0\t0\t0,0+1,0/0,0+0,1/0,0+-1,0/0,0+0,-1\n",
        ))
        .unwrap()
    }

    fn active_service_assignment() -> ActiveServiceAssignment {
        ActiveServiceAssignment {
            chair_instance_id: 1,
            table_instance_id: 2,
            chef_employee_id: 101,
            kitchen_instance_id: 3,
            waiter_employee_id: 201,
            waiter_tile: TilePoint { x: 4, y: 4 },
        }
    }

    fn aggregate_with_service_layout(
        session: VerifiedProductSession,
        catalog: &PlacementCatalog,
    ) -> ProductAggregate {
        let mut aggregate = ProductAggregate::new(session.subject, room());
        for (item_id, grant_id, place_id, tile, rotation) in [
            (
                11_u32,
                "grant-chair",
                "place-chair",
                TilePoint { x: 2, y: 2 },
                0_u8,
            ),
            (
                12_u32,
                "grant-table",
                "place-table",
                TilePoint { x: 3, y: 2 },
                0_u8,
            ),
            (
                13_u32,
                "grant-kitchen",
                "place-kitchen",
                TilePoint { x: 6, y: 4 },
                0_u8,
            ),
        ] {
            aggregate
                .apply_player_command(
                    session,
                    mutation(grant_id),
                    Command::GrantInventory {
                        item_id,
                        quantity: 1,
                    },
                )
                .unwrap();
            aggregate
                .place_owned_item(
                    session,
                    catalog,
                    mutation(place_id),
                    PlacementIntent {
                        item_id,
                        tile,
                        rotation,
                    },
                )
                .unwrap();
        }
        aggregate
    }

    #[test]
    fn persistence_codec_round_trip_revalidates_authoritative_state() {
        let session = VerifiedProductSession {
            subject: subject(7),
            session_id: ProductSessionId::from_verified_platform_bytes([9; 16]).unwrap(),
        };
        let catalog = catalog();
        let mut aggregate = ProductAggregate::new(subject(7), room());
        aggregate
            .apply_player_command(
                session,
                mutation("grant-1"),
                Command::GrantInventory {
                    item_id: 10,
                    quantity: 1,
                },
            )
            .unwrap();
        aggregate
            .place_owned_item(
                session,
                &catalog,
                mutation("place-1"),
                PlacementIntent {
                    item_id: 10,
                    tile: TilePoint { x: 2, y: 2 },
                    rotation: 0,
                },
            )
            .unwrap();

        let encoded = aggregate.encode_persisted().unwrap();
        let restored = ProductAggregate::decode_persisted(&catalog, &encoded).unwrap();
        assert_eq!(restored, aggregate);
    }

    #[test]
    fn active_service_replays_across_reopen_and_stops_at_settlement_boundary() {
        let session = VerifiedProductSession {
            subject: subject(7),
            session_id: ProductSessionId::from_verified_platform_bytes([9; 16]).unwrap(),
        };
        let catalog = active_service_catalog();
        let mut aggregate = aggregate_with_service_layout(session, &catalog);

        let started = aggregate
            .start_active_service(
                session,
                &catalog,
                mutation("service-start"),
                active_service_assignment(),
            )
            .unwrap();
        let started = match started {
            ActiveServiceMutationOutcome::Applied(Some(record)) => record,
            other => panic!("unexpected start outcome: {other:?}"),
        };
        assert_eq!(started.identity.service_id, 1);
        assert_eq!(started.identity.restaurant_mutation_sequence, 3);
        assert_eq!(
            aggregate
                .start_active_service(
                    session,
                    &catalog,
                    mutation("service-start"),
                    active_service_assignment(),
                )
                .unwrap(),
            ActiveServiceMutationOutcome::Duplicate(Some(started))
        );

        assert_eq!(
            aggregate
                .transform_owned_item(
                    session,
                    &catalog,
                    mutation("move-chair-during-service"),
                    1,
                    TilePoint { x: 2, y: 3 },
                    0,
                )
                .unwrap_err(),
            ProductServiceError::ActiveServiceLayoutLocked
        );

        let encoded = aggregate.encode_persisted().unwrap();
        let mut aggregate = ProductAggregate::decode_persisted(&catalog, &encoded).unwrap();
        assert_eq!(aggregate.active_service(), Some(started));

        let events = [
            ServiceLoopEvent::StartChairWalk,
            ServiceLoopEvent::ReachChair,
            ServiceLoopEvent::DecisionElapsed,
            ServiceLoopEvent::ChefAssigned {
                cook_duration_ms: 24_000,
            },
            ServiceLoopEvent::CookElapsed,
            ServiceLoopEvent::WaiterCollecting {
                action_delay_ms: 4_000,
            },
            ServiceLoopEvent::WaiterActionElapsed,
            ServiceLoopEvent::Served,
            ServiceLoopEvent::EatingElapsed,
            ServiceLoopEvent::PayingElapsed,
            ServiceLoopEvent::Left,
        ];
        for (index, event) in events.into_iter().enumerate() {
            let mutation_id = mutation(&format!("service-transition-{index}"));
            let outcome = aggregate
                .transition_active_service(session, mutation_id.clone(), 1, event)
                .unwrap();
            let current = match outcome {
                ActiveServiceMutationOutcome::Applied(Some(record)) => record,
                other => panic!("unexpected transition outcome: {other:?}"),
            };
            assert_eq!(
                aggregate
                    .transition_active_service(session, mutation_id, 1, event)
                    .unwrap(),
                ActiveServiceMutationOutcome::Duplicate(Some(current))
            );
        }

        let final_record = aggregate.active_service().unwrap();
        assert_eq!(final_record.state.customer, CustomerServiceState::Left);
        assert_eq!(final_record.state.order, OrderServiceState::EmptyPlate);

        assert_eq!(
            aggregate
                .transition_active_service(
                    session,
                    mutation("service-plate-clear-not-wired"),
                    1,
                    ServiceLoopEvent::PlateCleared,
                )
                .unwrap_err(),
            ProductServiceError::MealSettlementNotConnected
        );
        assert_eq!(aggregate.active_service(), Some(final_record));
        assert_eq!(
            aggregate
                .complete_active_service(session, mutation("service-complete-too-early"), 1)
                .unwrap_err(),
            ProductServiceError::ActiveServiceNotComplete
        );
        assert_eq!(
            aggregate
                .transform_owned_item(
                    session,
                    &catalog,
                    mutation("move-chair-still-active"),
                    1,
                    TilePoint { x: 2, y: 3 },
                    0,
                )
                .unwrap_err(),
            ProductServiceError::ActiveServiceLayoutLocked
        );

        let encoded = aggregate.encode_persisted().unwrap();
        let reopened = ProductAggregate::decode_persisted(&catalog, &encoded).unwrap();
        assert_eq!(reopened, aggregate);
        assert_eq!(reopened.active_service(), Some(final_record));
        assert_eq!(reopened.next_service_id, 2);
    }

    #[test]
    fn server_clock_catches_up_due_timer_once_and_persists_it() {
        let verifier = FakeVerifier {
            subject: subject(7),
            session_id: ProductSessionId::from_verified_platform_bytes([9; 16]).unwrap(),
        };
        let clock = FakeServiceClock::new(10_000);
        let store = InMemoryProductStateStore::default();
        let service = RestaurantProductService::new_with_clock(
            verifier,
            store,
            active_service_catalog(),
            room(),
            Arc::new(clock.clone()),
        );

        for (item_id, grant_id, place_id, tile) in [
            (
                11_u32,
                "clock-grant-chair",
                "clock-place-chair",
                TilePoint { x: 2, y: 2 },
            ),
            (
                12_u32,
                "clock-grant-table",
                "clock-place-table",
                TilePoint { x: 3, y: 2 },
            ),
            (
                13_u32,
                "clock-grant-kitchen",
                "clock-place-kitchen",
                TilePoint { x: 6, y: 4 },
            ),
        ] {
            service
                .apply_player_command(
                    "valid-product-session",
                    mutation(grant_id),
                    Command::GrantInventory {
                        item_id,
                        quantity: 1,
                    },
                )
                .unwrap();
            service
                .place_item(
                    "valid-product-session",
                    mutation(place_id),
                    PlacementIntent {
                        item_id,
                        tile,
                        rotation: 0,
                    },
                )
                .unwrap();
        }

        let started = service
            .start_active_service(
                "valid-product-session",
                mutation("clock-service-start"),
                active_service_assignment(),
            )
            .unwrap()
            .record()
            .unwrap();
        assert!(started.timing_anchored);
        assert_eq!(started.deadlines, ServiceDeadlines::default());

        service
            .transition_active_service(
                "valid-product-session",
                mutation("clock-start-walk"),
                1,
                ServiceLoopEvent::StartChairWalk,
            )
            .unwrap();
        service
            .transition_active_service(
                "valid-product-session",
                mutation("clock-reach-chair"),
                1,
                ServiceLoopEvent::ReachChair,
            )
            .unwrap();

        let deciding = service
            .load_active_service("valid-product-session")
            .unwrap()
            .unwrap();
        assert_eq!(deciding.state.customer, CustomerServiceState::Deciding);
        assert_eq!(deciding.deadlines.customer_deadline_at_ms, Some(11_000));

        clock.set(11_000);
        let waiting = service
            .load_active_service("valid-product-session")
            .unwrap()
            .unwrap();
        assert_eq!(waiting.state.customer, CustomerServiceState::Waiting);
        assert_eq!(waiting.state.order, OrderServiceState::Queued);
        assert_eq!(waiting.deadlines.customer_deadline_at_ms, Some(21_000));

        let subject = subject(7);
        let first = service.store.load(subject).unwrap().unwrap();
        let first_sequence = first.state.next_service_mutation_sequence;
        assert_eq!(
            service
                .load_active_service("valid-product-session")
                .unwrap(),
            Some(waiting)
        );
        let second = service.store.load(subject).unwrap().unwrap();
        assert_eq!(second.state.next_service_mutation_sequence, first_sequence);

        let encoded = second.state.encode_persisted().unwrap();
        let reopened =
            ProductAggregate::decode_persisted(&active_service_catalog(), &encoded).unwrap();
        assert_eq!(reopened.active_service(), Some(waiting));
    }

    #[test]
    fn v5_active_service_migrates_unanchored_then_gets_explicit_server_anchor() {
        let session = VerifiedProductSession {
            subject: subject(7),
            session_id: ProductSessionId::from_verified_platform_bytes([9; 16]).unwrap(),
        };
        let catalog = active_service_catalog();
        let mut aggregate = aggregate_with_service_layout(session, &catalog);
        aggregate
            .start_active_service(
                session,
                &catalog,
                mutation("legacy-v5-start"),
                active_service_assignment(),
            )
            .unwrap();
        aggregate
            .transition_active_service(
                session,
                mutation("legacy-v5-walk"),
                1,
                ServiceLoopEvent::StartChairWalk,
            )
            .unwrap();
        aggregate
            .transition_active_service(
                session,
                mutation("legacy-v5-chair"),
                1,
                ServiceLoopEvent::ReachChair,
            )
            .unwrap();

        let encoded = aggregate.encode_persisted().unwrap();
        let mut value: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        value["schema_version"] = serde_json::json!(5);
        if let Some(active) = value["active_service"].as_object_mut() {
            active.remove("timing_anchored");
            active.remove("customer_deadline_at_ms");
            active.remove("order_deadline_at_ms");
        }
        for mutation in value["service_mutations"].as_array_mut().unwrap() {
            if let Some(operation) = mutation["operation"].as_object_mut() {
                for payload in operation.values_mut() {
                    if let Some(payload) = payload.as_object_mut() {
                        payload.remove("effective_at_ms");
                    }
                }
            }
            if let Some(result) = mutation["result"].as_object_mut() {
                result.remove("timing_anchored");
                result.remove("customer_deadline_at_ms");
                result.remove("order_deadline_at_ms");
            }
        }

        let legacy_v5 = serde_json::to_vec(&value).unwrap();
        let mut restored = ProductAggregate::decode_persisted(&catalog, &legacy_v5).unwrap();
        let legacy = restored.active_service().unwrap();
        assert!(!legacy.timing_anchored);
        assert_eq!(legacy.deadlines, ServiceDeadlines::default());
        assert_eq!(legacy.state.customer, CustomerServiceState::Deciding);

        let anchored = restored
            .anchor_active_service_timing(session, mutation("v6-explicit-anchor"), 1, 50_000)
            .unwrap()
            .record()
            .unwrap();
        assert!(anchored.timing_anchored);
        assert_eq!(anchored.deadlines.customer_deadline_at_ms, Some(51_000));

        let encoded_v6 = restored.encode_persisted().unwrap();
        let reopened = ProductAggregate::decode_persisted(&catalog, &encoded_v6).unwrap();
        assert_eq!(reopened.active_service(), Some(anchored));
    }

    #[test]
    fn active_service_persistence_rejects_tampered_reducer_state() {
        let session = VerifiedProductSession {
            subject: subject(7),
            session_id: ProductSessionId::from_verified_platform_bytes([9; 16]).unwrap(),
        };
        let catalog = active_service_catalog();
        let mut aggregate = aggregate_with_service_layout(session, &catalog);
        aggregate
            .start_active_service(
                session,
                &catalog,
                mutation("service-start-tamper"),
                active_service_assignment(),
            )
            .unwrap();

        let encoded = aggregate.encode_persisted().unwrap();
        let mut value: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        value["active_service"]["state"]["customer"] = serde_json::json!("left");
        let tampered = serde_json::to_vec(&value).unwrap();

        assert_eq!(
            ProductAggregate::decode_persisted(&catalog, &tampered),
            Err(ProductStateStoreError::Corrupt)
        );
    }

    #[test]
    fn v4_state_migrates_to_empty_v5_service_domain() {
        let session = VerifiedProductSession {
            subject: subject(7),
            session_id: ProductSessionId::from_verified_platform_bytes([9; 16]).unwrap(),
        };
        let catalog = catalog();
        let mut aggregate = ProductAggregate::new(subject(7), room());
        aggregate
            .apply_player_command(
                session,
                mutation("grant-v4"),
                Command::GrantInventory {
                    item_id: 10,
                    quantity: 1,
                },
            )
            .unwrap();
        aggregate
            .place_owned_item(
                session,
                &catalog,
                mutation("place-v4"),
                PlacementIntent {
                    item_id: 10,
                    tile: TilePoint { x: 2, y: 2 },
                    rotation: 0,
                },
            )
            .unwrap();

        let encoded = aggregate.encode_persisted().unwrap();
        let mut value: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        value["schema_version"] = serde_json::json!(4);
        value.as_object_mut().unwrap().remove("active_service");
        value.as_object_mut().unwrap().remove("service_mutations");
        value
            .as_object_mut()
            .unwrap()
            .remove("next_service_mutation_sequence");
        value.as_object_mut().unwrap().remove("next_service_id");

        let legacy_v4 = serde_json::to_vec(&value).unwrap();
        let restored = ProductAggregate::decode_persisted(&catalog, &legacy_v4).unwrap();
        assert_eq!(
            restored.restaurant.snapshot(),
            aggregate.restaurant.snapshot()
        );
        assert_eq!(restored.active_service(), None);
        assert!(restored.service_mutations.is_empty());
        assert_eq!(restored.next_service_mutation_sequence, 1);
        assert_eq!(restored.next_service_id, 1);
    }

    #[test]
    fn wall_attachment_round_trip_is_server_rotated_and_idempotent() {
        let session = VerifiedProductSession {
            subject: subject(7),
            session_id: ProductSessionId::from_verified_platform_bytes([9; 16]).unwrap(),
        };
        let catalog = wall_catalog();
        let mut aggregate = ProductAggregate::new(subject(7), room());
        aggregate
            .apply_player_command(
                session,
                mutation("grant-wall"),
                Command::GrantInventory {
                    item_id: 60,
                    quantity: 1,
                },
            )
            .unwrap();

        let first = aggregate
            .place_owned_item(
                session,
                &catalog,
                mutation("place-wall"),
                PlacementIntent {
                    item_id: 60,
                    tile: TilePoint { x: 2, y: 0 },
                    rotation: 0,
                },
            )
            .unwrap();
        let placed = match first {
            PlacementMutationOutcome::Applied(item) => item,
            PlacementMutationOutcome::Duplicate(_) => unreachable!(),
        };
        assert_eq!(placed.rotation, 1);

        assert_eq!(
            aggregate
                .place_owned_item(
                    session,
                    &catalog,
                    mutation("place-wall"),
                    PlacementIntent {
                        item_id: 60,
                        tile: TilePoint { x: 2, y: 0 },
                        rotation: 15,
                    },
                )
                .unwrap(),
            PlacementMutationOutcome::Duplicate(placed)
        );

        let moved = aggregate
            .transform_owned_item(
                session,
                &catalog,
                mutation("move-wall"),
                placed.instance_id,
                TilePoint { x: 0, y: 3 },
                15,
            )
            .unwrap();
        let moved = match moved {
            PlacementMutationOutcome::Applied(item) => item,
            PlacementMutationOutcome::Duplicate(_) => unreachable!(),
        };
        assert_eq!(moved.rotation, 0);

        assert_eq!(
            aggregate
                .transform_owned_item(
                    session,
                    &catalog,
                    mutation("move-wall"),
                    placed.instance_id,
                    TilePoint { x: 0, y: 3 },
                    0,
                )
                .unwrap(),
            PlacementMutationOutcome::Duplicate(moved)
        );

        let encoded = aggregate.encode_persisted().unwrap();
        let restored = ProductAggregate::decode_persisted(&catalog, &encoded).unwrap();
        assert_eq!(restored, aggregate);
        let snapshot = restored.restaurant_product_snapshot(session).unwrap();
        assert_eq!(snapshot.restaurant.items, vec![moved]);
        assert_eq!(snapshot.inventory[0].placed, 1);
        assert_eq!(snapshot.inventory[0].available, 0);
    }

    #[test]
    fn simple_door_place_transform_remove_idempotency_and_reopen() {
        let session = VerifiedProductSession {
            subject: subject(7),
            session_id: ProductSessionId::from_verified_platform_bytes([9; 16]).unwrap(),
        };
        let catalog = door_catalog();
        let mut aggregate = ProductAggregate::new(subject(7), room());
        aggregate
            .apply_player_command(
                session,
                mutation("grant-simple-door"),
                Command::GrantInventory {
                    item_id: 3_010_000,
                    quantity: 1,
                },
            )
            .unwrap();

        let first = aggregate
            .place_owned_item(
                session,
                &catalog,
                mutation("place-simple-door"),
                PlacementIntent {
                    item_id: 3_010_000,
                    tile: TilePoint { x: 2, y: 0 },
                    rotation: 0,
                },
            )
            .unwrap();
        let placed = match first {
            PlacementMutationOutcome::Applied(item) => item,
            PlacementMutationOutcome::Duplicate(_) => unreachable!(),
        };
        assert_eq!(placed.rotation, 1);
        assert_eq!(
            aggregate
                .place_owned_item(
                    session,
                    &catalog,
                    mutation("place-simple-door"),
                    PlacementIntent {
                        item_id: 3_010_000,
                        tile: TilePoint { x: 2, y: 0 },
                        rotation: 15,
                    },
                )
                .unwrap(),
            PlacementMutationOutcome::Duplicate(placed)
        );

        let moved = aggregate
            .transform_owned_item(
                session,
                &catalog,
                mutation("move-simple-door"),
                placed.instance_id,
                TilePoint { x: 0, y: 3 },
                15,
            )
            .unwrap();
        let moved = match moved {
            PlacementMutationOutcome::Applied(item) => item,
            PlacementMutationOutcome::Duplicate(_) => unreachable!(),
        };
        assert_eq!(moved.rotation, 0);
        assert_eq!(
            aggregate
                .transform_owned_item(
                    session,
                    &catalog,
                    mutation("move-simple-door"),
                    placed.instance_id,
                    TilePoint { x: 0, y: 3 },
                    0,
                )
                .unwrap(),
            PlacementMutationOutcome::Duplicate(moved)
        );

        let encoded = aggregate.encode_persisted().unwrap();
        let mut restored = ProductAggregate::decode_persisted(&catalog, &encoded).unwrap();
        assert_eq!(restored, aggregate);
        let before_remove = restored.restaurant_product_snapshot(session).unwrap();
        assert_eq!(before_remove.restaurant.items, vec![moved]);
        assert_eq!(before_remove.inventory[0].placed, 1);
        assert_eq!(before_remove.inventory[0].available, 0);

        let removed = restored
            .remove_owned_item(session, mutation("remove-simple-door"), moved.instance_id)
            .unwrap();
        assert_eq!(removed, PlacementMutationOutcome::Applied(moved));
        assert_eq!(
            restored
                .remove_owned_item(session, mutation("remove-simple-door"), moved.instance_id,)
                .unwrap(),
            PlacementMutationOutcome::Duplicate(moved)
        );

        let after_remove = restored.restaurant_product_snapshot(session).unwrap();
        assert!(after_remove.restaurant.items.is_empty());
        assert_eq!(after_remove.inventory[0].placed, 0);
        assert_eq!(after_remove.inventory[0].available, 1);

        let encoded_removed = restored.encode_persisted().unwrap();
        let reopened = ProductAggregate::decode_persisted(&catalog, &encoded_removed).unwrap();
        assert_eq!(reopened, restored);
        assert_eq!(
            reopened
                .restaurant_product_snapshot(session)
                .unwrap()
                .inventory[0]
                .available,
            1
        );
    }

    #[test]
    fn wallpaper_apply_replace_remove_idempotency_and_reopen() {
        let session = VerifiedProductSession {
            subject: subject(7),
            session_id: ProductSessionId::from_verified_platform_bytes([9; 16]).unwrap(),
        };
        let catalog = wallpaper_catalog();
        let mut aggregate = ProductAggregate::new(subject(7), room());

        for (item_id, mutation_id) in [
            (3_060_000, "grant-wallpaper-a"),
            (3_060_001, "grant-wallpaper-b"),
        ] {
            aggregate
                .apply_player_command(
                    session,
                    mutation(mutation_id),
                    Command::GrantInventory {
                        item_id,
                        quantity: 1,
                    },
                )
                .unwrap();
        }

        let first = aggregate
            .apply_owned_wallpaper(
                session,
                &catalog,
                mutation("apply-wallpaper-left-a"),
                WallpaperIntent {
                    item_id: 3_060_000,
                    wall_tile: TilePoint { x: 0, y: 2 },
                },
            )
            .unwrap();
        let left_a = match first {
            WallpaperMutationOutcome::Applied(wallpaper) => wallpaper,
            WallpaperMutationOutcome::Duplicate(_) => unreachable!(),
        };
        assert_eq!(
            left_a,
            AppliedWallpaper {
                item_id: 3_060_000,
                orientation: WallpaperOrientation::Left,
            }
        );
        assert_eq!(
            aggregate
                .apply_owned_wallpaper(
                    session,
                    &catalog,
                    mutation("apply-wallpaper-left-a"),
                    WallpaperIntent {
                        item_id: 3_060_000,
                        wall_tile: TilePoint { x: 0, y: 6 },
                    },
                )
                .unwrap(),
            WallpaperMutationOutcome::Duplicate(left_a)
        );

        let left_b = match aggregate
            .apply_owned_wallpaper(
                session,
                &catalog,
                mutation("replace-wallpaper-left-b"),
                WallpaperIntent {
                    item_id: 3_060_001,
                    wall_tile: TilePoint { x: 0, y: 4 },
                },
            )
            .unwrap()
        {
            WallpaperMutationOutcome::Applied(wallpaper) => wallpaper,
            WallpaperMutationOutcome::Duplicate(_) => unreachable!(),
        };
        let top_a = match aggregate
            .apply_owned_wallpaper(
                session,
                &catalog,
                mutation("apply-wallpaper-top-a"),
                WallpaperIntent {
                    item_id: 3_060_000,
                    wall_tile: TilePoint { x: 3, y: 0 },
                },
            )
            .unwrap()
        {
            WallpaperMutationOutcome::Applied(wallpaper) => wallpaper,
            WallpaperMutationOutcome::Duplicate(_) => unreachable!(),
        };

        assert_eq!(left_b.orientation, WallpaperOrientation::Left);
        assert_eq!(top_a.orientation, WallpaperOrientation::Top);

        let snapshot = aggregate.restaurant_product_snapshot(session).unwrap();
        assert_eq!(snapshot.wallpapers, vec![left_b, top_a]);
        let a = snapshot
            .inventory
            .iter()
            .find(|entry| entry.item_id == 3_060_000)
            .unwrap();
        let b = snapshot
            .inventory
            .iter()
            .find(|entry| entry.item_id == 3_060_001)
            .unwrap();
        assert_eq!((a.placed, a.available), (1, 0));
        assert_eq!((b.placed, b.available), (1, 0));

        let encoded = aggregate.encode_persisted().unwrap();
        let mut restored = ProductAggregate::decode_persisted(&catalog, &encoded).unwrap();
        assert_eq!(restored, aggregate);

        let removed = restored
            .remove_owned_wallpaper(
                session,
                mutation("remove-wallpaper-left"),
                WallpaperOrientation::Left,
            )
            .unwrap();
        assert_eq!(removed, WallpaperMutationOutcome::Applied(left_b));
        assert_eq!(
            restored
                .remove_owned_wallpaper(
                    session,
                    mutation("remove-wallpaper-left"),
                    WallpaperOrientation::Left,
                )
                .unwrap(),
            WallpaperMutationOutcome::Duplicate(left_b)
        );

        let after_remove = restored.restaurant_product_snapshot(session).unwrap();
        assert_eq!(after_remove.wallpapers, vec![top_a]);
        let b = after_remove
            .inventory
            .iter()
            .find(|entry| entry.item_id == 3_060_001)
            .unwrap();
        assert_eq!((b.placed, b.available), (0, 1));

        let encoded_removed = restored.encode_persisted().unwrap();
        let reopened = ProductAggregate::decode_persisted(&catalog, &encoded_removed).unwrap();
        assert_eq!(reopened, restored);
    }

    #[test]
    fn v3_floor_tile_round_trip_replays_floor_journal() {
        let session = VerifiedProductSession {
            subject: subject(7),
            session_id: ProductSessionId::from_verified_platform_bytes([9; 16]).unwrap(),
        };
        let catalog = floor_catalog();
        let mut aggregate = ProductAggregate::new(subject(7), room());
        aggregate
            .apply_player_command(
                session,
                mutation("grant-floor"),
                Command::GrantInventory {
                    item_id: 30,
                    quantity: 1,
                },
            )
            .unwrap();
        aggregate
            .paint_owned_floor_tile(
                session,
                &catalog,
                mutation("paint-floor"),
                FloorTileIntent {
                    item_id: 30,
                    tile: TilePoint { x: 2, y: 3 },
                },
            )
            .unwrap();

        let encoded = aggregate.encode_persisted().unwrap();
        let restored = ProductAggregate::decode_persisted(&catalog, &encoded).unwrap();
        assert_eq!(restored, aggregate);
        let snapshot = restored.restaurant_product_snapshot(session).unwrap();
        assert_eq!(
            snapshot.floor_tiles,
            vec![PaintedFloorTile {
                item_id: 30,
                tile: TilePoint { x: 2, y: 3 },
                room_index: 0,
            }]
        );
        assert_eq!(snapshot.inventory[0].placed, 1);
        assert_eq!(snapshot.inventory[0].available, 0);
    }

    #[test]
    fn v2_state_migrates_to_empty_v3_floor_domain() {
        let session = VerifiedProductSession {
            subject: subject(7),
            session_id: ProductSessionId::from_verified_platform_bytes([9; 16]).unwrap(),
        };
        let catalog = catalog();
        let mut aggregate = ProductAggregate::new(subject(7), room());
        aggregate
            .apply_player_command(
                session,
                mutation("grant-v2"),
                Command::GrantInventory {
                    item_id: 10,
                    quantity: 1,
                },
            )
            .unwrap();
        aggregate
            .place_owned_item(
                session,
                &catalog,
                mutation("place-v2"),
                PlacementIntent {
                    item_id: 10,
                    tile: TilePoint { x: 2, y: 2 },
                    rotation: 0,
                },
            )
            .unwrap();

        let encoded = aggregate.encode_persisted().unwrap();
        let mut value: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        value["schema_version"] = serde_json::json!(2);
        value["restaurant"]
            .as_object_mut()
            .unwrap()
            .remove("floor_tiles");
        value
            .as_object_mut()
            .unwrap()
            .remove("next_floor_mutation_sequence");
        value.as_object_mut().unwrap().remove("floor_mutations");
        value["restaurant"]
            .as_object_mut()
            .unwrap()
            .remove("wallpapers");
        value
            .as_object_mut()
            .unwrap()
            .remove("next_wallpaper_mutation_sequence");
        value.as_object_mut().unwrap().remove("wallpaper_mutations");
        let legacy_v2 = serde_json::to_vec(&value).unwrap();

        let restored = ProductAggregate::decode_persisted(&catalog, &legacy_v2).unwrap();
        assert_eq!(
            restored.restaurant.snapshot(),
            aggregate.restaurant.snapshot()
        );
        assert!(restored.floor_tiles.is_empty());
        assert!(restored.floor_mutations.is_empty());
        assert_eq!(restored.next_floor_mutation_sequence, 1);
    }

    #[test]
    fn v3_state_migrates_to_empty_v4_wallpaper_domain() {
        let session = VerifiedProductSession {
            subject: subject(7),
            session_id: ProductSessionId::from_verified_platform_bytes([9; 16]).unwrap(),
        };
        let catalog = floor_catalog();
        let mut aggregate = ProductAggregate::new(subject(7), room());
        aggregate
            .apply_player_command(
                session,
                mutation("grant-v3-floor"),
                Command::GrantInventory {
                    item_id: 30,
                    quantity: 1,
                },
            )
            .unwrap();
        aggregate
            .paint_owned_floor_tile(
                session,
                &catalog,
                mutation("paint-v3-floor"),
                FloorTileIntent {
                    item_id: 30,
                    tile: TilePoint { x: 2, y: 2 },
                },
            )
            .unwrap();

        let encoded = aggregate.encode_persisted().unwrap();
        let mut value: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        value["schema_version"] = serde_json::json!(3);
        value["restaurant"]
            .as_object_mut()
            .unwrap()
            .remove("wallpapers");
        value
            .as_object_mut()
            .unwrap()
            .remove("next_wallpaper_mutation_sequence");
        value.as_object_mut().unwrap().remove("wallpaper_mutations");

        let legacy_v3 = serde_json::to_vec(&value).unwrap();
        let restored = ProductAggregate::decode_persisted(&catalog, &legacy_v3).unwrap();
        assert_eq!(restored.floor_tiles, aggregate.floor_tiles);
        assert!(restored.wallpapers.is_empty());
        assert!(restored.wallpaper_mutations.is_empty());
        assert_eq!(restored.next_wallpaper_mutation_sequence, 1);
    }

    #[test]
    fn floor_paint_is_idempotent_and_replacement_reconciles_inventory() {
        let service = floor_service();
        for (id, mutation_id) in [(30, "grant-floor-a"), (31, "grant-floor-b")] {
            service
                .apply_player_command(
                    "valid-product-session",
                    mutation(mutation_id),
                    Command::GrantInventory {
                        item_id: id,
                        quantity: 1,
                    },
                )
                .unwrap();
        }

        let first = service
            .paint_floor_tile(
                "valid-product-session",
                mutation("paint-floor-a"),
                FloorTileIntent {
                    item_id: 30,
                    tile: TilePoint { x: 2, y: 2 },
                },
            )
            .unwrap();
        assert_eq!(
            service
                .paint_floor_tile(
                    "valid-product-session",
                    mutation("paint-floor-a"),
                    FloorTileIntent {
                        item_id: 30,
                        tile: TilePoint { x: 2, y: 2 },
                    },
                )
                .unwrap(),
            match first {
                FloorTileMutationOutcome::Applied(tile) => {
                    FloorTileMutationOutcome::Duplicate(tile)
                }
                FloorTileMutationOutcome::Duplicate(_) => unreachable!(),
            }
        );

        service
            .paint_floor_tile(
                "valid-product-session",
                mutation("paint-floor-b"),
                FloorTileIntent {
                    item_id: 31,
                    tile: TilePoint { x: 2, y: 2 },
                },
            )
            .unwrap();

        let snapshot = service.load_restaurant("valid-product-session").unwrap();
        assert_eq!(snapshot.floor_tiles.len(), 1);
        assert_eq!(snapshot.floor_tiles[0].item_id, 31);
        let a = snapshot
            .inventory
            .iter()
            .find(|entry| entry.item_id == 30)
            .unwrap();
        let b = snapshot
            .inventory
            .iter()
            .find(|entry| entry.item_id == 31)
            .unwrap();
        assert_eq!((a.placed, a.available), (0, 1));
        assert_eq!((b.placed, b.available), (1, 0));
    }

    #[test]
    fn consuming_inventory_cannot_orphan_a_painted_floor_tile() {
        let service = floor_service();
        service
            .apply_player_command(
                "valid-product-session",
                mutation("grant-floor-consume"),
                Command::GrantInventory {
                    item_id: 30,
                    quantity: 1,
                },
            )
            .unwrap();
        service
            .paint_floor_tile(
                "valid-product-session",
                mutation("paint-floor-consume"),
                FloorTileIntent {
                    item_id: 30,
                    tile: TilePoint { x: 2, y: 2 },
                },
            )
            .unwrap();

        assert_eq!(
            service
                .apply_player_command(
                    "valid-product-session",
                    mutation("consume-floor"),
                    Command::ConsumeInventory {
                        item_id: 30,
                        quantity: 1,
                    },
                )
                .unwrap_err(),
            ProductServiceError::ItemUnavailable {
                item_id: 30,
                owned: 1,
                placed: 1,
            }
        );
    }

    #[test]
    fn persistence_rejects_placed_item_without_owned_inventory() {
        let session = VerifiedProductSession {
            subject: subject(7),
            session_id: ProductSessionId::from_verified_platform_bytes([9; 16]).unwrap(),
        };
        let catalog = catalog();
        let mut aggregate = ProductAggregate::new(subject(7), room());
        aggregate
            .apply_player_command(
                session,
                mutation("grant-1"),
                Command::GrantInventory {
                    item_id: 10,
                    quantity: 1,
                },
            )
            .unwrap();
        aggregate
            .place_owned_item(
                session,
                &catalog,
                mutation("place-1"),
                PlacementIntent {
                    item_id: 10,
                    tile: TilePoint { x: 2, y: 2 },
                    rotation: 0,
                },
            )
            .unwrap();

        let encoded = aggregate.encode_persisted().unwrap();
        let mut value: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        value["player"]["inventory"] = serde_json::json!([]);
        let tampered = serde_json::to_vec(&value).unwrap();

        assert_eq!(
            ProductAggregate::decode_persisted(&catalog, &tampered),
            Err(ProductStateStoreError::Corrupt)
        );
    }

    #[test]
    fn consuming_inventory_cannot_orphan_a_placed_item() {
        let service = service();
        service
            .apply_player_command(
                "valid-product-session",
                mutation("grant-1"),
                Command::GrantInventory {
                    item_id: 10,
                    quantity: 1,
                },
            )
            .unwrap();
        service
            .place_item(
                "valid-product-session",
                mutation("place-1"),
                PlacementIntent {
                    item_id: 10,
                    tile: TilePoint { x: 2, y: 2 },
                    rotation: 0,
                },
            )
            .unwrap();

        assert_eq!(
            service
                .apply_player_command(
                    "valid-product-session",
                    mutation("consume-1"),
                    Command::ConsumeInventory {
                        item_id: 10,
                        quantity: 1,
                    },
                )
                .unwrap_err(),
            ProductServiceError::ItemUnavailable {
                item_id: 10,
                owned: 1,
                placed: 1,
            }
        );
    }

    #[test]
    fn compare_and_swap_rejects_stale_revision() {
        let store = InMemoryProductStateStore::default();
        let subject = subject(7);
        let first = ProductAggregate::new(subject, room());

        assert_eq!(
            store
                .compare_and_swap(subject, None, first.clone())
                .unwrap(),
            1
        );
        assert_eq!(
            store.compare_and_swap(subject, None, first),
            Err(ProductStateStoreError::Conflict)
        );
    }

    #[test]
    fn cloned_in_memory_store_shares_atomic_revision_state() {
        let store = InMemoryProductStateStore::default();
        let cloned = store.clone();
        let subject = subject(7);
        let aggregate = ProductAggregate::new(subject, room());

        assert_eq!(
            store
                .compare_and_swap(subject, None, aggregate.clone())
                .unwrap(),
            1
        );
        assert_eq!(
            cloned.compare_and_swap(subject, None, aggregate),
            Err(ProductStateStoreError::Conflict)
        );
        assert_eq!(cloned.load(subject).unwrap().unwrap().store_revision, 1);
    }

    #[test]
    fn invalid_platform_session_cannot_read_or_mutate_product_state() {
        let service = service();

        assert_eq!(
            service.load_restaurant("bad"),
            Err(ProductServiceError::Session(PlatformSessionError::Invalid))
        );
        assert_eq!(
            service.apply_player_command(
                "bad",
                mutation("grant-1"),
                Command::GrantInventory {
                    item_id: 10,
                    quantity: 1,
                },
            ),
            Err(ProductServiceError::Session(PlatformSessionError::Invalid))
        );
    }

    #[test]
    fn placement_requires_owned_inventory() {
        let service = service();

        assert_eq!(
            service
                .place_item(
                    "valid-product-session",
                    mutation("place-1"),
                    PlacementIntent {
                        item_id: 10,
                        tile: TilePoint { x: 2, y: 2 },
                        rotation: 0,
                    },
                )
                .unwrap_err(),
            ProductServiceError::ItemUnavailable {
                item_id: 10,
                owned: 0,
                placed: 0,
            }
        );
    }

    #[test]
    fn authenticated_owned_item_placement_is_idempotent() {
        let service = service();
        service
            .apply_player_command(
                "valid-product-session",
                mutation("grant-1"),
                Command::GrantInventory {
                    item_id: 10,
                    quantity: 1,
                },
            )
            .unwrap();

        let intent = PlacementIntent {
            item_id: 10,
            tile: TilePoint { x: 2, y: 2 },
            rotation: 0,
        };
        let first = service
            .place_item("valid-product-session", mutation("place-1"), intent)
            .unwrap();
        let second = service
            .place_item("valid-product-session", mutation("place-1"), intent)
            .unwrap();

        let PlacementMutationOutcome::Applied(placed) = first else {
            panic!("first placement must apply");
        };
        assert_eq!(second, PlacementMutationOutcome::Duplicate(placed));

        let snapshot = service.load_restaurant("valid-product-session").unwrap();
        assert_eq!(snapshot.restaurant.items, vec![placed]);
        assert_eq!(snapshot.inventory.len(), 1);
        assert_eq!(snapshot.inventory[0].item_id, 10);
        assert_eq!(snapshot.inventory[0].owned, 1);
        assert_eq!(snapshot.inventory[0].placed, 1);
        assert_eq!(snapshot.inventory[0].available, 0);
    }

    #[test]
    fn owned_quantity_limits_simultaneous_placements() {
        let service = service();
        service
            .apply_player_command(
                "valid-product-session",
                mutation("grant-1"),
                Command::GrantInventory {
                    item_id: 10,
                    quantity: 1,
                },
            )
            .unwrap();

        service
            .place_item(
                "valid-product-session",
                mutation("place-1"),
                PlacementIntent {
                    item_id: 10,
                    tile: TilePoint { x: 2, y: 2 },
                    rotation: 0,
                },
            )
            .unwrap();

        assert_eq!(
            service
                .place_item(
                    "valid-product-session",
                    mutation("place-2"),
                    PlacementIntent {
                        item_id: 10,
                        tile: TilePoint { x: 5, y: 2 },
                        rotation: 0,
                    },
                )
                .unwrap_err(),
            ProductServiceError::ItemUnavailable {
                item_id: 10,
                owned: 1,
                placed: 1,
            }
        );
    }

    #[test]
    fn load_without_existing_state_is_safe_and_empty() {
        let service = service();
        let snapshot = service.load_restaurant("valid-product-session").unwrap();

        assert!(snapshot.restaurant.items.is_empty());
        assert!(snapshot.inventory.is_empty());
        assert_eq!(snapshot.restaurant.room.inside_x, 8);
        assert_eq!(snapshot.restaurant.room.inside_y, 8);
    }
}
