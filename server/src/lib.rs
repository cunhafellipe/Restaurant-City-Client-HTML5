//! ANEWON Restaurant City product-authoritative domain.
//!
//! This crate intentionally has no provider OAuth code, browser authority,
//! AnewPack cryptography or legacy RPC transport. Those concerns belong to
//! ANEWON Platform, ANEWON Runtime, and compatibility adapters respectively.

pub mod domain;
pub mod platform;
pub mod placement;

pub use domain::{
    AuthorityError, Command, Inventory, MutationId, MutationOutcome, PlayerState, Wallet,
};
pub use platform::{
    AnewSubject, PlatformSessionError, PlatformSessionVerifier, ProductSessionId, PRODUCT_ID,
    VerifiedProductSession,
};

pub use placement::{
    Footprint, PlacementFlags, PlacementShape, RoomDimensions, ScreenPoint, StructuralPlacement,
    TilePoint, ROOM_INDEX_MAIN, ROOM_INDEX_OUTSIDE_AREA,
};
