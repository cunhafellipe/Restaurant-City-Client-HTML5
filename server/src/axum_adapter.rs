use crate::http::{
    ProductHttpContext, PublicProductError, handle_load_restaurant,
    handle_place_item as handle_place_item_contract,
};
use crate::platform::PlatformSessionVerifier;
use crate::service::{ProductStateStore, RestaurantProductService};
use axum::{
    Router,
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{
        HeaderMap, HeaderName, StatusCode,
        header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE},
    },
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Serialize;
use std::sync::Arc;

const IDEMPOTENCY_KEY: HeaderName = HeaderName::from_static("idempotency-key");
const JSON_CONTENT_TYPE: &str = "application/json; charset=utf-8";
const MAX_REQUEST_BODY_BYTES: usize = 4 * 1024;

struct AppState<V, S> {
    service: Arc<RestaurantProductService<V, S>>,
}

impl<V, S> Clone for AppState<V, S> {
    fn clone(&self) -> Self {
        Self {
            service: Arc::clone(&self.service),
        }
    }
}

pub fn restaurant_router<V, S>(service: RestaurantProductService<V, S>) -> Router
where
    V: PlatformSessionVerifier + Send + Sync + 'static,
    S: ProductStateStore + 'static,
{
    let state = AppState {
        service: Arc::new(service),
    };

    Router::new()
        .route("/api/v1/restaurant", get(load_restaurant::<V, S>))
        .route("/api/v1/restaurant/placements", post(place_item::<V, S>))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
        .with_state(state)
}

async fn load_restaurant<V, S>(State(state): State<AppState<V, S>>, headers: HeaderMap) -> Response
where
    V: PlatformSessionVerifier + Send + Sync + 'static,
    S: ProductStateStore + 'static,
{
    let authorization = header_value(&headers, &AUTHORIZATION);

    match handle_load_restaurant(
        state.service.as_ref(),
        ProductHttpContext {
            authorization,
            mutation_id: None,
        },
    ) {
        Ok(body) => success_response(StatusCode::OK, body),
        Err(error) => error_response(error),
    }
}

async fn place_item<V, S>(
    State(state): State<AppState<V, S>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response
where
    V: PlatformSessionVerifier + Send + Sync + 'static,
    S: ProductStateStore + 'static,
{
    let authorization = header_value(&headers, &AUTHORIZATION);
    let mutation_id = header_value(&headers, &IDEMPOTENCY_KEY);

    match handle_place_item_contract(
        state.service.as_ref(),
        ProductHttpContext {
            authorization,
            mutation_id,
        },
        &body,
    ) {
        Ok(response) => success_response(StatusCode::OK, response),
        Err(error) => error_response(error),
    }
}

fn header_value<'a>(headers: &'a HeaderMap, name: &HeaderName) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn success_response(status: StatusCode, body: Vec<u8>) -> Response {
    (
        status,
        [
            (CONTENT_TYPE, JSON_CONTENT_TYPE),
            (CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

#[derive(Serialize)]
struct PublicErrorEnvelope {
    error: PublicErrorBody,
}

#[derive(Serialize)]
struct PublicErrorBody {
    code: &'static str,
}

fn error_response(error: PublicProductError) -> Response {
    let status =
        StatusCode::from_u16(error.status_code()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let body = serde_json::to_vec(&PublicErrorEnvelope {
        error: PublicErrorBody { code: error.code() },
    })
    .unwrap_or_else(|_| br#"{"error":{"code":"INTERNAL"}}"#.to_vec());

    success_response(status, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Command, MutationId};
    use crate::persistence::RedbProductStateStore;
    use crate::placement::{Footprint, PlacementFlags, RoomDimensions};
    use crate::platform::{
        AnewSubject, PlatformSessionError, ProductSessionId, VerifiedProductSession,
    };
    use crate::restaurant::{ItemPlacementDefinition, PlacementCatalog};
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };
    use tower::ServiceExt;

    static NEXT_DB_ID: AtomicU64 = AtomicU64::new(1);

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

    fn subject() -> AnewSubject {
        AnewSubject::from_verified_platform_bytes([7; 16]).unwrap()
    }

    fn verifier() -> FakeVerifier {
        FakeVerifier {
            subject: subject(),
            session_id: ProductSessionId::from_verified_platform_bytes([9; 16]).unwrap(),
        }
    }

    fn catalog() -> PlacementCatalog {
        PlacementCatalog::new([ItemPlacementDefinition {
            item_id: 10,
            footprint: Footprint {
                size_x: 2,
                size_y: 1,
            },
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

    fn temp_database() -> PathBuf {
        let id = NEXT_DB_ID.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "anewon-restaurant-city-http-{}-{id}.redb",
            std::process::id()
        ))
    }

    fn auth_request(method: &str, uri: &str, body: &'static str) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header(AUTHORIZATION, "Bearer session")
            .header(&IDEMPOTENCY_KEY, "placement-1")
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap()
    }

    #[tokio::test]
    async fn unauthorized_layout_request_returns_public_401() {
        let service = RestaurantProductService::new(
            verifier(),
            crate::service::InMemoryProductStateStore::default(),
            catalog(),
            room(),
        );
        let response = restaurant_router(service)
            .oneshot(
                Request::builder()
                    .uri("/api/v1/restaurant")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response.headers()[CACHE_CONTROL], "no-store");

        let body = to_bytes(response.into_body(), MAX_REQUEST_BODY_BYTES)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["error"]["code"], "UNAUTHENTICATED");
    }

    #[tokio::test]
    async fn placement_survives_service_and_database_reopen() {
        let path = temp_database();
        let catalog = catalog();

        {
            let store = RedbProductStateStore::open(&path, catalog.clone()).unwrap();
            let service = RestaurantProductService::new(verifier(), store, catalog.clone(), room());

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

            let response = restaurant_router(service)
                .oneshot(auth_request(
                    "POST",
                    "/api/v1/restaurant/placements",
                    r#"{"item_id":10,"tile_x":2,"tile_y":2,"rotation":0}"#,
                ))
                .await
                .unwrap();

            assert_eq!(response.status(), StatusCode::OK);
        }

        {
            let store = RedbProductStateStore::open(&path, catalog.clone()).unwrap();
            let service = RestaurantProductService::new(verifier(), store, catalog, room());

            let response = restaurant_router(service)
                .oneshot(
                    Request::builder()
                        .uri("/api/v1/restaurant")
                        .header(AUTHORIZATION, "Bearer session")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();

            assert_eq!(response.status(), StatusCode::OK);
            let body = to_bytes(response.into_body(), MAX_REQUEST_BODY_BYTES)
                .await
                .unwrap();
            let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(value["items"].as_array().unwrap().len(), 1);
            assert_eq!(value["items"][0]["item_id"], 10);
            assert_eq!(value["items"][0]["tile_x"], 2);
            assert_eq!(value["items"][0]["tile_y"], 2);
        }

        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn duplicate_idempotency_key_does_not_create_second_item() {
        let service = RestaurantProductService::new(
            verifier(),
            crate::service::InMemoryProductStateStore::default(),
            catalog(),
            room(),
        );
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

        let app = restaurant_router(service);
        let first = app
            .clone()
            .oneshot(auth_request(
                "POST",
                "/api/v1/restaurant/placements",
                r#"{"item_id":10,"tile_x":2,"tile_y":2,"rotation":0}"#,
            ))
            .await
            .unwrap();
        let second = app
            .oneshot(auth_request(
                "POST",
                "/api/v1/restaurant/placements",
                r#"{"item_id":10,"tile_x":2,"tile_y":2,"rotation":0}"#,
            ))
            .await
            .unwrap();

        let first_body = to_bytes(first.into_body(), MAX_REQUEST_BODY_BYTES)
            .await
            .unwrap();
        let second_body = to_bytes(second.into_body(), MAX_REQUEST_BODY_BYTES)
            .await
            .unwrap();
        let first_json: serde_json::Value = serde_json::from_slice(&first_body).unwrap();
        let second_json: serde_json::Value = serde_json::from_slice(&second_body).unwrap();

        assert_eq!(first_json["outcome"], "applied");
        assert_eq!(second_json["outcome"], "duplicate");
        assert_eq!(
            first_json["item"]["instance_id"],
            second_json["item"]["instance_id"]
        );
    }

    #[tokio::test]
    async fn oversized_or_malformed_payload_is_rejected() {
        let service = RestaurantProductService::new(
            verifier(),
            crate::service::InMemoryProductStateStore::default(),
            catalog(),
            room(),
        );
        let app = restaurant_router(service);

        let malformed = app
            .clone()
            .oneshot(auth_request(
                "POST",
                "/api/v1/restaurant/placements",
                r#"{"item_id":10,"tile_x":2,"tile_y":2,"rotation":0,"extra":true}"#,
            ))
            .await
            .unwrap();
        assert_eq!(malformed.status(), StatusCode::BAD_REQUEST);

        let oversized = app
            .oneshot(auth_request(
                "POST",
                "/api/v1/restaurant/placements",
                Box::leak("x".repeat(MAX_REQUEST_BODY_BYTES + 1).into_boxed_str()),
            ))
            .await
            .unwrap();
        assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }
}
