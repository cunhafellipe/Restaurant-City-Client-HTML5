//! Framework-independent HTTP/wire contract for the Restaurant City product.
//!
//! This module deliberately does not own sockets, TLS, routing, cookies or
//! ANEWON Platform authentication. A concrete HTTP adapter extracts the opaque
//! product-session token and supplies it with request bytes; the product
//! service verifies the Product-scoped session.

use crate::domain::MutationId;
use crate::placement::TilePoint;
use crate::platform::{PlatformSessionError, PlatformSessionVerifier};
use crate::restaurant::{PlacedItem, PlacementIntent, RestaurantSnapshot};
use crate::service::{
    PlacementMutationOutcome, ProductServiceError, ProductStateStore, RestaurantProductService,
};
use serde::{Deserialize, Serialize};

const MAX_BODY_BYTES: usize = 4 * 1024;
const MAX_SESSION_TOKEN_BYTES: usize = 2 * 1024;
const MAX_MUTATION_ID_BYTES: usize = 128;

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

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
pub struct RestaurantLayoutResponse {
    pub room: RoomResponse,
    pub next_instance_id: u64,
    pub items: Vec<PlacedItemResponse>,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
pub struct PlacementResponse {
    pub outcome: &'static str,
    pub item: PlacedItemResponse,
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
    let snapshot = service.load_restaurant(session_token).map_err(map_service_error)?;
    json_bytes(&layout_response(snapshot))
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

    if dto.rotation > 3 {
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

fn layout_response(snapshot: RestaurantSnapshot) -> RestaurantLayoutResponse {
    RestaurantLayoutResponse {
        room: RoomResponse {
            inside_x: snapshot.room.inside_x,
            inside_y: snapshot.room.inside_y,
            outside_x: snapshot.room.outside_x,
            outside_y: snapshot.room.outside_y,
        },
        next_instance_id: snapshot.next_instance_id,
        items: snapshot
            .items
            .into_iter()
            .map(placed_item_response)
            .collect(),
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
            crate::restaurant::RestaurantAuthorityError::Collision { .. },
        ) => PublicProductError::Conflict,
        ProductServiceError::RestaurantAuthority(_) => PublicProductError::Unprocessable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
            bearer_token: &str,
        ) -> Result<VerifiedProductSession, PlatformSessionError> {
            if bearer_token != "session" {
                return Err(PlatformSessionError::Invalid);
            }
            Ok(VerifiedProductSession {
                subject: self.subject,
                session_id: self.session_id,
            })
        }
    }

    fn service() -> RestaurantProductService<FakeVerifier, InMemoryProductStateStore> {
        let catalog = PlacementCatalog::new([ItemPlacementDefinition {
            item_id: 10,
            footprint: Footprint {
                size_x: 2,
                size_y: 1,
            },
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
        handle_place_item(
            &service,
            context(Some("session"), Some("place-1")),
            request,
        )
        .unwrap();
        let duplicate = handle_place_item(
            &service,
            context(Some("session"), Some("place-1")),
            request,
        )
        .unwrap();

        let json: serde_json::Value = serde_json::from_slice(&duplicate).unwrap();
        assert_eq!(json["outcome"], "duplicate");
        assert_eq!(json["item"]["instance_id"], 1);
    }

    #[test]
    fn public_error_mapping_does_not_leak_authority_details() {
        assert_eq!(PublicProductError::Unauthenticated.status_code(), 401);
        assert_eq!(PublicProductError::Conflict.status_code(), 409);
        assert_eq!(PublicProductError::Unprocessable.code(), "UNPROCESSABLE");
    }
}
