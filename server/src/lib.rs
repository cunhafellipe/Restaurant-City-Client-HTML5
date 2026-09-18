//! ANEWON Restaurant City product-authoritative domain.
//!
//! This crate intentionally has no provider OAuth code, browser authority,
//! AnewPack cryptography or legacy RPC transport. Those concerns belong to
//! ANEWON Platform, ANEWON Runtime, and compatibility adapters respectively.

pub mod domain;
pub mod http;
pub mod persistence;
pub mod placement;
pub mod platform;
pub mod restaurant;
pub mod service;

pub use domain::{
    AuthorityError, Command, Inventory, MutationId, MutationOutcome, PlayerState, Wallet,
};
pub use platform::{
    AnewSubject, PRODUCT_ID, PlatformSessionError, PlatformSessionVerifier, ProductSessionId,
    VerifiedProductSession,
};

pub use placement::{
    Footprint, PlacementFlags, PlacementShape, ROOM_INDEX_MAIN, ROOM_INDEX_OUTSIDE_AREA,
    RoomDimensions, ScreenPoint, StructuralPlacement, TilePoint,
};

pub use restaurant::{
    ItemPlacementDefinition, PLACEMENT_CATALOG_MAGIC, PlacedItem, PlacementCatalog,
    PlacementCatalogLoadError, PlacementIntent, RestaurantAuthorityError, RestaurantSnapshot,
    RestaurantState,
};

pub use service::{
    InMemoryProductStateStore, LoadedProductState, PlacementMutationOutcome, ProductAggregate,
    ProductServiceError, ProductStateStore, ProductStateStoreError, RestaurantProductService,
};

pub use persistence::RedbProductStateStore;

pub use http::{
    PlacedItemResponse, PlacementResponse, ProductHttpContext, PublicProductError,
    RestaurantLayoutResponse, RoomResponse, handle_load_restaurant, handle_place_item,
};
