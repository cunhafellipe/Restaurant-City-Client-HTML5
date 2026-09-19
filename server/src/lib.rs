//! ANEWON Restaurant City product-authoritative domain.
//!
//! This crate intentionally has no provider OAuth code, browser authority,
//! AnewPack cryptography or legacy RPC transport. Those concerns belong to
//! ANEWON Platform, ANEWON Runtime, and compatibility adapters respectively.

pub mod active_service;
pub mod axum_adapter;
pub mod domain;
pub mod gameplay;
pub mod http;
pub mod persistence;
pub mod placement;
pub mod platform;
pub mod restaurant;
pub mod service;
pub mod service_clock;
pub mod service_path;
pub mod topology;

pub use active_service::{
    ActiveServiceAssignment, ActiveServiceError, ActiveServiceIdentity, ActiveServiceRecord,
};

pub use domain::{
    AuthorityError, Command, Inventory, MutationId, MutationOutcome, PlayerState, Wallet,
};
pub use gameplay::{
    CHEF_COOK_MAX_MS, CHEF_COOK_MIN_MS, CUSTOMER_DECISION_MS, CUSTOMER_EATING_MS,
    CUSTOMER_PAYING_MS, CUSTOMER_WAIT_FOOD_MS, CUSTOMER_WAIT_ORDER_MS,
    CUSTOMERS_PER_MINUTE_PER_DEMAND, CustomerServiceState, GameplayRuleError, MAX_DEMAND,
    MealReward, OrderServiceState, ServiceLoopEffect, ServiceLoopError, ServiceLoopEvent,
    ServiceLoopState, ServiceLoopTransition, WAITER_ACTION_MAX_MS, WAITER_ACTION_MIN_MS,
    canonical_chef_base_cook_duration_ms, canonical_customer_spawn_delay_ms, canonical_meal_reward,
    transition_service_loop,
};
pub use platform::{
    AnewSubject, PRODUCT_ID, PlatformSessionError, PlatformSessionVerifier, ProductSessionId,
    VerifiedProductSession,
};
pub use topology::{
    HistoricalPath, ServiceChair, ServiceChef, ServiceDrink, ServiceKitchen, ServiceLayoutSnapshot,
    ServiceTable, ServiceTopologyGrid, ServiceTopologySnapshot, ServiceWaiter, TopologyBuildError,
    TopologyCell, TopologyError, calculate_food_service_topology, derive_service_layout,
    facing_tile, historical_path, is_table_free, path_to_customer_chair, table_for_chair,
};

pub use placement::{
    Footprint, HistoricalTileStackEntry, HistoricalTileStackValidation, PlacementFlags,
    PlacementShape, ROOM_INDEX_MAIN, ROOM_INDEX_OUTSIDE_AREA, RoomDimensions, ScreenPoint,
    StructuralPlacement, TilePoint, validate_historical_tile_stack,
};

pub use restaurant::{
    AppliedWallpaper, ItemPlacementDefinition, PLACEMENT_CATALOG_MAGIC, PlacedItem,
    PlacementCatalog, PlacementCatalogLoadError, PlacementIntent, RestaurantAuthorityError,
    RestaurantSnapshot, RestaurantState, ServiceItemFlags, WallpaperIntent, WallpaperOrientation,
};

pub use service::{
    ActiveServiceMutationOutcome, InMemoryProductStateStore, InventoryAvailability,
    LoadedProductState, PlacementMutationOutcome, ProductAggregate, ProductServiceError,
    ProductStateStore, ProductStateStoreError, RestaurantProductService, RestaurantProductSnapshot,
    WallpaperMutationOutcome,
};

pub use service_clock::{
    DueServiceEvent, ServiceDeadlines, ServiceTimeSource, ServiceTimingError,
    SystemServiceTimeSource, TimedServiceCatchUp, TimedServiceTransition, anchor_service_deadlines,
    catch_up_timed_service, due_service_event, remaining_ms, transition_timed_service,
    validate_service_deadlines,
};

pub use service_path::{
    CUSTOMER_MOVE_SPEED_X_PX_PER_MS, CUSTOMER_MOVE_SPEED_Y_PX_PER_MS,
    HISTORICAL_TILE_HEIGHT_HALF_PX, HISTORICAL_TILE_HEIGHT_PX, HISTORICAL_TILE_WIDTH_HALF_PX,
    HISTORICAL_TILE_WIDTH_PX, ServicePathError, ServicePathKind, ServicePathPlan,
    ServicePathSegmentProjection, WAITER_MOVE_SPEED_Y_MAX_PX_PER_MS,
    WAITER_MOVE_SPEED_Y_MIN_PX_PER_MS, canonical_waiter_walk_speed_y, customer_path_duration_ms,
    customer_path_to_chair, customer_path_to_exit, historical_path_signature,
    is_valid_customer_entrance, path_duration_ms, plan_customer_path_to_chair,
    project_customer_path_to_chair_segment, segment_duration_ms,
    validate_customer_path_to_chair_plan, waiter_path_duration_ms, waiter_path_to_customer,
    waiter_path_to_kitchen_pickup,
};

pub use persistence::RedbProductStateStore;

pub use http::{
    ActiveServiceEnvelopeResponse, ActiveServiceResponse, InventoryAvailabilityResponse,
    PlacedItemResponse, PlacementResponse, ProductHttpContext, PublicProductError,
    RestaurantLayoutResponse, RoomResponse, ServiceChairResponse, ServiceDrinkResponse,
    ServiceKitchenResponse, ServiceTableResponse, ServiceTopologyCellResponse,
    ServiceTopologyResponse, ServiceTopologySourceResponse, WallpaperMutationResponse,
    WallpaperResponse, handle_apply_wallpaper, handle_load_active_service, handle_load_restaurant,
    handle_load_service_topology, handle_place_item, handle_remove_item, handle_remove_wallpaper,
    handle_transform_item,
};

pub use axum_adapter::restaurant_router;
