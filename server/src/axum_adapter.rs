use crate::http::{
    ProductHttpContext, PublicProductError,
    handle_apply_wallpaper as handle_apply_wallpaper_contract, handle_load_restaurant,
    handle_load_service_topology,
    handle_paint_floor_tile as handle_paint_floor_tile_contract,
    handle_place_item as handle_place_item_contract,
    handle_remove_item as handle_remove_item_contract,
    handle_remove_wallpaper as handle_remove_wallpaper_contract,
    handle_transform_item as handle_transform_item_contract,
};
use crate::platform::PlatformSessionVerifier;
use crate::service::{ProductStateStore, RestaurantProductService};
use axum::{
    Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{
        HeaderMap, HeaderName, StatusCode,
        header::{CACHE_CONTROL, CONTENT_TYPE, COOKIE, ORIGIN},
    },
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post, put},
};
use serde::Serialize;
use std::sync::Arc;

const IDEMPOTENCY_KEY: HeaderName = HeaderName::from_static("idempotency-key");
const SEC_FETCH_SITE: HeaderName = HeaderName::from_static("sec-fetch-site");
const PRODUCT_SESSION_COOKIE_NAME: &str = "__Host-anewon-product-session";
const JSON_CONTENT_TYPE: &str = "application/json; charset=utf-8";
const MAX_REQUEST_BODY_BYTES: usize = 4 * 1024;
const MAX_COOKIE_HEADER_BYTES: usize = 8 * 1024;
const MAX_SESSION_TOKEN_BYTES: usize = 2 * 1024;

struct AppState<V, S> {
    service: Arc<RestaurantProductService<V, S>>,
    expected_origin: Arc<str>,
}

impl<V, S> Clone for AppState<V, S> {
    fn clone(&self) -> Self {
        Self {
            service: Arc::clone(&self.service),
            expected_origin: Arc::clone(&self.expected_origin),
        }
    }
}

pub fn restaurant_router<V, S>(
    service: RestaurantProductService<V, S>,
    expected_origin: impl Into<Arc<str>>,
) -> Router
where
    V: PlatformSessionVerifier + Send + Sync + 'static,
    S: ProductStateStore + 'static,
{
    let state = AppState {
        service: Arc::new(service),
        expected_origin: expected_origin.into(),
    };

    Router::new()
        .route("/api/v1/restaurant", get(load_restaurant::<V, S>))
        .route(
            "/api/v1/restaurant/topology",
            get(load_service_topology::<V, S>),
        )
        .route("/api/v1/restaurant/placements", post(place_item::<V, S>))
        .route(
            "/api/v1/restaurant/floor-tiles",
            put(paint_floor_tile::<V, S>),
        )
        .route(
            "/api/v1/restaurant/wallpapers",
            put(apply_wallpaper::<V, S>),
        )
        .route(
            "/api/v1/restaurant/wallpapers/{rotation}",
            delete(remove_wallpaper::<V, S>),
        )
        .route(
            "/api/v1/restaurant/placements/{instance_id}",
            patch(transform_item::<V, S>).delete(remove_item::<V, S>),
        )
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
        .with_state(state)
}

async fn load_restaurant<V, S>(State(state): State<AppState<V, S>>, headers: HeaderMap) -> Response
where
    V: PlatformSessionVerifier + Send + Sync + 'static,
    S: ProductStateStore + 'static,
{
    if let Err(error) = validate_request_security(&headers, &state.expected_origin, false) {
        return error_response(error);
    }

    let session_token = match product_session_token(&headers) {
        Ok(token) => token,
        Err(error) => return error_response(error),
    };

    match handle_load_restaurant(
        state.service.as_ref(),
        ProductHttpContext {
            session_token: Some(session_token),
            mutation_id: None,
        },
    ) {
        Ok(body) => success_response(StatusCode::OK, body),
        Err(error) => error_response(error),
    }
}

async fn load_service_topology<V, S>(
    State(state): State<AppState<V, S>>,
    headers: HeaderMap,
) -> Response
where
    V: PlatformSessionVerifier + Send + Sync + 'static,
    S: ProductStateStore + 'static,
{
    if let Err(error) = validate_request_security(&headers, &state.expected_origin, false) {
        return error_response(error);
    }

    let session_token = match product_session_token(&headers) {
        Ok(token) => token,
        Err(error) => return error_response(error),
    };

    match handle_load_service_topology(
        state.service.as_ref(),
        ProductHttpContext {
            session_token: Some(session_token),
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
    if let Err(error) = validate_request_security(&headers, &state.expected_origin, true) {
        return error_response(error);
    }

    let session_token = match product_session_token(&headers) {
        Ok(token) => token,
        Err(error) => return error_response(error),
    };
    let mutation_id = header_value(&headers, &IDEMPOTENCY_KEY);

    match handle_place_item_contract(
        state.service.as_ref(),
        ProductHttpContext {
            session_token: Some(session_token),
            mutation_id,
        },
        &body,
    ) {
        Ok(response) => success_response(StatusCode::OK, response),
        Err(error) => error_response(error),
    }
}

async fn paint_floor_tile<V, S>(
    State(state): State<AppState<V, S>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response
where
    V: PlatformSessionVerifier + Send + Sync + 'static,
    S: ProductStateStore + 'static,
{
    if let Err(error) = validate_request_security(&headers, &state.expected_origin, true) {
        return error_response(error);
    }

    let session_token = match product_session_token(&headers) {
        Ok(token) => token,
        Err(error) => return error_response(error),
    };
    let mutation_id = header_value(&headers, &IDEMPOTENCY_KEY);

    match handle_paint_floor_tile_contract(
        state.service.as_ref(),
        ProductHttpContext {
            session_token: Some(session_token),
            mutation_id,
        },
        &body,
    ) {
        Ok(response) => success_response(StatusCode::OK, response),
        Err(error) => error_response(error),
    }
}

async fn apply_wallpaper<V, S>(
    State(state): State<AppState<V, S>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response
where
    V: PlatformSessionVerifier + Send + Sync + 'static,
    S: ProductStateStore + 'static,
{
    if let Err(error) = validate_request_security(&headers, &state.expected_origin, true) {
        return error_response(error);
    }

    let session_token = match product_session_token(&headers) {
        Ok(token) => token,
        Err(error) => return error_response(error),
    };
    let mutation_id = header_value(&headers, &IDEMPOTENCY_KEY);

    match handle_apply_wallpaper_contract(
        state.service.as_ref(),
        ProductHttpContext {
            session_token: Some(session_token),
            mutation_id,
        },
        &body,
    ) {
        Ok(response) => success_response(StatusCode::OK, response),
        Err(error) => error_response(error),
    }
}

async fn remove_wallpaper<V, S>(
    State(state): State<AppState<V, S>>,
    Path(rotation): Path<u8>,
    headers: HeaderMap,
) -> Response
where
    V: PlatformSessionVerifier + Send + Sync + 'static,
    S: ProductStateStore + 'static,
{
    if let Err(error) = validate_request_security(&headers, &state.expected_origin, true) {
        return error_response(error);
    }

    let session_token = match product_session_token(&headers) {
        Ok(token) => token,
        Err(error) => return error_response(error),
    };
    let mutation_id = header_value(&headers, &IDEMPOTENCY_KEY);

    match handle_remove_wallpaper_contract(
        state.service.as_ref(),
        ProductHttpContext {
            session_token: Some(session_token),
            mutation_id,
        },
        rotation,
    ) {
        Ok(response) => success_response(StatusCode::OK, response),
        Err(error) => error_response(error),
    }
}

async fn transform_item<V, S>(
    State(state): State<AppState<V, S>>,
    Path(instance_id): Path<u64>,
    headers: HeaderMap,
    body: Bytes,
) -> Response
where
    V: PlatformSessionVerifier + Send + Sync + 'static,
    S: ProductStateStore + 'static,
{
    if let Err(error) = validate_request_security(&headers, &state.expected_origin, true) {
        return error_response(error);
    }

    let session_token = match product_session_token(&headers) {
        Ok(token) => token,
        Err(error) => return error_response(error),
    };
    let mutation_id = header_value(&headers, &IDEMPOTENCY_KEY);

    match handle_transform_item_contract(
        state.service.as_ref(),
        ProductHttpContext {
            session_token: Some(session_token),
            mutation_id,
        },
        instance_id,
        &body,
    ) {
        Ok(response) => success_response(StatusCode::OK, response),
        Err(error) => error_response(error),
    }
}

async fn remove_item<V, S>(
    State(state): State<AppState<V, S>>,
    Path(instance_id): Path<u64>,
    headers: HeaderMap,
) -> Response
where
    V: PlatformSessionVerifier + Send + Sync + 'static,
    S: ProductStateStore + 'static,
{
    if let Err(error) = validate_request_security(&headers, &state.expected_origin, true) {
        return error_response(error);
    }

    let session_token = match product_session_token(&headers) {
        Ok(token) => token,
        Err(error) => return error_response(error),
    };
    let mutation_id = header_value(&headers, &IDEMPOTENCY_KEY);

    match handle_remove_item_contract(
        state.service.as_ref(),
        ProductHttpContext {
            session_token: Some(session_token),
            mutation_id,
        },
        instance_id,
    ) {
        Ok(response) => success_response(StatusCode::OK, response),
        Err(error) => error_response(error),
    }
}

fn validate_request_security(
    headers: &HeaderMap,
    expected_origin: &str,
    require_origin: bool,
) -> Result<(), PublicProductError> {
    if expected_origin.is_empty() {
        return Err(PublicProductError::Internal);
    }

    if let Some(site) = header_value(headers, &SEC_FETCH_SITE)
        && !matches!(site, "same-origin" | "none")
    {
        return Err(PublicProductError::InvalidRequest);
    }

    match header_value(headers, &ORIGIN) {
        Some(origin) if origin != expected_origin => Err(PublicProductError::InvalidRequest),
        None if require_origin => Err(PublicProductError::InvalidRequest),
        Some(_) | None => Ok(()),
    }
}

fn product_session_token(headers: &HeaderMap) -> Result<&str, PublicProductError> {
    let header = header_value(headers, &COOKIE).ok_or(PublicProductError::Unauthenticated)?;
    if header.is_empty() || header.len() > MAX_COOKIE_HEADER_BYTES || !header.is_ascii() {
        return Err(PublicProductError::Unauthenticated);
    }

    let mut found: Option<&str> = None;
    for pair in header.split(';') {
        let pair = pair.trim();
        if pair.is_empty() {
            continue;
        }

        let Some((name, value)) = pair.split_once('=') else {
            return Err(PublicProductError::Unauthenticated);
        };
        if name.trim() != PRODUCT_SESSION_COOKIE_NAME {
            continue;
        }

        let value = value.trim();
        if value.is_empty()
            || value.len() > MAX_SESSION_TOKEN_BYTES
            || !value.is_ascii()
            || !value.bytes().all(valid_cookie_octet)
        {
            return Err(PublicProductError::Unauthenticated);
        }

        if found.replace(value).is_some() {
            return Err(PublicProductError::Unauthenticated);
        }
    }

    found.ok_or(PublicProductError::Unauthenticated)
}

const fn valid_cookie_octet(byte: u8) -> bool {
    matches!(
        byte,
        0x21 | 0x23..=0x2b | 0x2d..=0x3a | 0x3c..=0x5b | 0x5d..=0x7e
    )
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
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
    };
    use tower::ServiceExt;

    const EXPECTED_ORIGIN: &str = "https://play.anewon.test";
    const SESSION_COOKIE: &str = "__Host-anewon-product-session=session";
    static NEXT_DB_ID: AtomicU64 = AtomicU64::new(1);

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
            rotation_count: 4,
            flags: PlacementFlags::default(),
        }])
        .unwrap()
    }

    fn wallpaper_catalog() -> PlacementCatalog {
        PlacementCatalog::new([ItemPlacementDefinition {
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
            .header(COOKIE, SESSION_COOKIE)
            .header(ORIGIN, EXPECTED_ORIGIN)
            .header(&SEC_FETCH_SITE, "same-origin")
            .header(&IDEMPOTENCY_KEY, "placement-1")
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap()
    }

    fn mutation_request(
        method: &str,
        uri: &str,
        mutation_id: &str,
        body: &'static str,
    ) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header(COOKIE, SESSION_COOKIE)
            .header(ORIGIN, EXPECTED_ORIGIN)
            .header(&SEC_FETCH_SITE, "same-origin")
            .header(&IDEMPOTENCY_KEY, mutation_id)
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap()
    }

    fn authenticated_get() -> Request<Body> {
        Request::builder()
            .uri("/api/v1/restaurant")
            .header(COOKIE, SESSION_COOKIE)
            .header(&SEC_FETCH_SITE, "same-origin")
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn router_serves_over_real_loopback_socket() {
        let service = RestaurantProductService::new(
            verifier(),
            crate::service::InMemoryProductStateStore::default(),
            catalog(),
            room(),
        );
        let app = restaurant_router(service, EXPECTED_ORIGIN);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let mut stream = TcpStream::connect(address).await.unwrap();
        stream
            .write_all(
                b"GET /api/v1/restaurant HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();

        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        let response = String::from_utf8(response).unwrap();

        assert!(response.starts_with("HTTP/1.1 401 Unauthorized\r\n"));
        assert!(response.contains("cache-control: no-store"));
        assert!(response.contains("\"code\":\"UNAUTHENTICATED\""));

        server.abort();
    }

    #[tokio::test]
    async fn unauthorized_layout_request_returns_public_401() {
        let service = RestaurantProductService::new(
            verifier(),
            crate::service::InMemoryProductStateStore::default(),
            catalog(),
            room(),
        );
        let response = restaurant_router(service, EXPECTED_ORIGIN)
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
    async fn duplicate_product_session_cookie_fails_closed() {
        let service = RestaurantProductService::new(
            verifier(),
            crate::service::InMemoryProductStateStore::default(),
            catalog(),
            room(),
        );

        let response = restaurant_router(service, EXPECTED_ORIGIN)
            .oneshot(
                Request::builder()
                    .uri("/api/v1/restaurant")
                    .header(
                        COOKIE,
                        "__Host-anewon-product-session=session; __Host-anewon-product-session=other",
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn cross_origin_mutation_is_rejected_before_authority() {
        let service = RestaurantProductService::new(
            verifier(),
            crate::service::InMemoryProductStateStore::default(),
            catalog(),
            room(),
        );

        let response = restaurant_router(service, EXPECTED_ORIGIN)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/restaurant/placements")
                    .header(COOKIE, SESSION_COOKIE)
                    .header(ORIGIN, "https://evil.example")
                    .header(&SEC_FETCH_SITE, "cross-site")
                    .header(&IDEMPOTENCY_KEY, "placement-1")
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"item_id":10,"tile_x":2,"tile_y":2,"rotation":0}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
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

            let response = restaurant_router(service, EXPECTED_ORIGIN)
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

            let response = restaurant_router(service, EXPECTED_ORIGIN)
                .oneshot(authenticated_get())
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

        let app = restaurant_router(service, EXPECTED_ORIGIN);
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
    async fn transform_and_remove_round_trip_through_router_and_persistence() {
        let path = temp_database();
        let catalog = catalog();

        {
            let store = RedbProductStateStore::open(&path, catalog.clone()).unwrap();
            let service = RestaurantProductService::new(verifier(), store, catalog.clone(), room());
            service
                .apply_player_command(
                    "session",
                    MutationId::new("grant-edit-router".to_owned()).unwrap(),
                    Command::GrantInventory {
                        item_id: 10,
                        quantity: 1,
                    },
                )
                .unwrap();

            let app = restaurant_router(service, EXPECTED_ORIGIN);
            let placed = app
                .clone()
                .oneshot(mutation_request(
                    "POST",
                    "/api/v1/restaurant/placements",
                    "place-edit-router",
                    r#"{"item_id":10,"tile_x":2,"tile_y":2,"rotation":0}"#,
                ))
                .await
                .unwrap();
            assert_eq!(placed.status(), StatusCode::OK);

            let transformed = app
                .clone()
                .oneshot(mutation_request(
                    "PATCH",
                    "/api/v1/restaurant/placements/1",
                    "transform-edit-router",
                    r#"{"tile_x":4,"tile_y":3,"rotation":1}"#,
                ))
                .await
                .unwrap();
            assert_eq!(transformed.status(), StatusCode::OK);

            let transformed_body = to_bytes(transformed.into_body(), MAX_REQUEST_BODY_BYTES)
                .await
                .unwrap();
            let transformed_json: serde_json::Value =
                serde_json::from_slice(&transformed_body).unwrap();
            assert_eq!(transformed_json["item"]["instance_id"], 1);
            assert_eq!(transformed_json["item"]["tile_x"], 4);
            assert_eq!(transformed_json["item"]["tile_y"], 3);
            assert_eq!(transformed_json["item"]["rotation"], 1);

            let removed = app
                .oneshot(mutation_request(
                    "DELETE",
                    "/api/v1/restaurant/placements/1",
                    "remove-edit-router",
                    "",
                ))
                .await
                .unwrap();
            assert_eq!(removed.status(), StatusCode::OK);
        }

        {
            let store = RedbProductStateStore::open(&path, catalog.clone()).unwrap();
            let service = RestaurantProductService::new(verifier(), store, catalog, room());
            let response = restaurant_router(service, EXPECTED_ORIGIN)
                .oneshot(authenticated_get())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            let body = to_bytes(response.into_body(), MAX_REQUEST_BODY_BYTES)
                .await
                .unwrap();
            let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(json["items"].as_array().unwrap().len(), 0);
            assert_eq!(json["inventory"][0]["owned"], 1);
            assert_eq!(json["inventory"][0]["placed"], 0);
            assert_eq!(json["inventory"][0]["available"], 1);
        }

        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn wallpaper_routes_round_trip_through_router() {
        let service = RestaurantProductService::new(
            verifier(),
            crate::service::InMemoryProductStateStore::default(),
            wallpaper_catalog(),
            room(),
        );
        service
            .apply_player_command(
                "session",
                MutationId::new("grant-wallpaper-route".to_owned()).unwrap(),
                Command::GrantInventory {
                    item_id: 3_060_000,
                    quantity: 1,
                },
            )
            .unwrap();
        let app = restaurant_router(service, EXPECTED_ORIGIN);

        let applied = app
            .clone()
            .oneshot(mutation_request(
                "PUT",
                "/api/v1/restaurant/wallpapers",
                "wallpaper-route-apply",
                r#"{"item_id":3060000,"tile_x":3,"tile_y":0}"#,
            ))
            .await
            .unwrap();
        assert_eq!(applied.status(), StatusCode::OK);
        let body = to_bytes(applied.into_body(), MAX_REQUEST_BODY_BYTES)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["wallpaper"]["rotation"], 1);

        let layout = app.clone().oneshot(authenticated_get()).await.unwrap();
        assert_eq!(layout.status(), StatusCode::OK);
        let body = to_bytes(layout.into_body(), MAX_REQUEST_BODY_BYTES)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["wallpapers"].as_array().unwrap().len(), 1);
        assert_eq!(json["inventory"][0]["placed"], 1);

        let removed = app
            .clone()
            .oneshot(mutation_request(
                "DELETE",
                "/api/v1/restaurant/wallpapers/1",
                "wallpaper-route-remove",
                "",
            ))
            .await
            .unwrap();
        assert_eq!(removed.status(), StatusCode::OK);

        let duplicate = app
            .clone()
            .oneshot(mutation_request(
                "DELETE",
                "/api/v1/restaurant/wallpapers/1",
                "wallpaper-route-remove",
                "",
            ))
            .await
            .unwrap();
        assert_eq!(duplicate.status(), StatusCode::OK);
        let body = to_bytes(duplicate.into_body(), MAX_REQUEST_BODY_BYTES)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["outcome"], "duplicate");

        let layout = app.oneshot(authenticated_get()).await.unwrap();
        let body = to_bytes(layout.into_body(), MAX_REQUEST_BODY_BYTES)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["wallpapers"].as_array().unwrap().len(), 0);
        assert_eq!(json["inventory"][0]["available"], 1);
    }

    #[tokio::test]
    async fn oversized_or_malformed_payload_is_rejected() {
        let service = RestaurantProductService::new(
            verifier(),
            crate::service::InMemoryProductStateStore::default(),
            catalog(),
            room(),
        );
        let app = restaurant_router(service, EXPECTED_ORIGIN);

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
