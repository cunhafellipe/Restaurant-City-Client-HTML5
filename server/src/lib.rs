//! ANEWON Restaurant City product-authoritative domain.
//!
//! This crate intentionally has no provider OAuth code, browser authority,
//! AnewPack cryptography or legacy RPC transport. Those concerns belong to
//! ANEWON Platform, ANEWON Runtime, and compatibility adapters respectively.

pub mod axum_adapter;
pub mod domain;
pub mod http;
pub mod gameplay;
pub mod persistence;
pub mod placement;
pub mod platform;
pub mod restaurant;
pub mod service;

pub use domain::{
    AuthorityError, Command, Inventory, MutationId, MutationOutcome, PlayerState, Wallet,
};
pub use gameplay::{
    CHEF_COOK_MAX_MS, CHEF_COOK_MIN_MS, CUSTOMER_DECISION_MS, CUSTOMER_EATING_MS,
    CUSTOMER_PAYING_MS, CUSTOMER_WAIT_FOOD_MS, CUSTOMER_WAIT_ORDER_MS,
    CUSTOMERS_PER_MINUTE_PER_DEMAND, GameplayRuleError, MAX_DEMAND, MealReward,
    WAITER_ACTION_MAX_MS, WAITER_ACTION_MIN_MS, canonical_chef_base_cook_duration_ms,
    canonical_customer_spawn_delay_ms, canonical_meal_reward,
};
pub use platform::{
    AnewSubject, PRODUCT_ID, PlatformSessionError, PlatformSessionVerifier, ProductSessionId,
    VerifiedProductSession,
};

pub use placement::{
    Footprint, HistoricalTileStackEntry, HistoricalTileStackValidation, PlacementFlags,
    PlacementShape, ROOM_INDEX_MAIN, ROOM_INDEX_OUTSIDE_AREA, RoomDimensions, ScreenPoint,
    StructuralPlacement, TilePoint, validate_historical_tile_stack,
};

pub use restaurant::{
    AppliedWallpaper, ItemPlacementDefinition, PLACEMENT_CATALOG_MAGIC, PlacedItem,
    PlacementCatalog, PlacementCatalogLoadError, PlacementIntent, RestaurantAuthorityError,
    RestaurantSnapshot, RestaurantState, WallpaperIntent, WallpaperOrientation,
};

pub use service::{
    InMemoryProductStateStore, InventoryAvailability, LoadedProductState, PlacementMutationOutcome,
    ProductAggregate, ProductServiceError, ProductStateStore, ProductStateStoreError,
    RestaurantProductService, RestaurantProductSnapshot, WallpaperMutationOutcome,
};

pub use persistence::RedbProductStateStore;

pub use http::{
    InventoryAvailabilityResponse, PlacedItemResponse, PlacementResponse, ProductHttpContext,
    PublicProductError, RestaurantLayoutResponse, RoomResponse, WallpaperMutationResponse,
    WallpaperResponse, handle_apply_wallpaper, handle_load_restaurant, handle_place_item,
    handle_remove_item, handle_remove_wallpaper, handle_transform_item,
};

pub use axum_adapter::restaurant_router;
