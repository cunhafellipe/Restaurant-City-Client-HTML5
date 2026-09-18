use crate::domain::{
    AuthorityError, Command, MutationId, MutationOutcome, PlayerPersistenceSnapshot, PlayerState,
};
use crate::placement::{RoomDimensions, TilePoint};
use crate::platform::{
    AnewSubject, PlatformSessionError, PlatformSessionVerifier, VerifiedProductSession,
};
use crate::restaurant::{
    PlacedItem, PlacementCatalog, PlacementIntent, RestaurantAuthorityError, RestaurantSnapshot,
    RestaurantState,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

const PRODUCT_PERSISTENCE_SCHEMA_VERSION: u8 = 1;
const MAX_STORE_RETRIES: usize = 3;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlacementMutationOutcome {
    Applied(PlacedItem),
    Duplicate(PlacedItem),
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
    pub inventory: Vec<InventoryAvailability>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductAggregate {
    player: PlayerState,
    restaurant: RestaurantState,
    placement_mutations: BTreeMap<MutationId, PlacedItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedAggregate {
    schema_version: u8,
    player: PlayerPersistenceSnapshot,
    restaurant: PersistedRestaurant,
    placement_mutations: Vec<PersistedPlacementMutation>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedRestaurant {
    room: PersistedRoom,
    next_instance_id: u64,
    items: Vec<PersistedPlacedItem>,
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedPlacementMutation {
    mutation_id: String,
    item: PersistedPlacedItem,
}

impl ProductAggregate {
    pub fn new(subject: AnewSubject, room: RoomDimensions) -> Self {
        Self {
            player: PlayerState::new(subject),
            restaurant: RestaurantState::new(room),
            placement_mutations: BTreeMap::new(),
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
            },
            placement_mutations: self
                .placement_mutations
                .iter()
                .map(|(mutation_id, item)| PersistedPlacementMutation {
                    mutation_id: mutation_id.as_str().to_owned(),
                    item: PersistedPlacedItem::from(*item),
                })
                .collect(),
        };

        serde_json::to_vec(&persisted).map_err(|_| ProductStateStoreError::Corrupt)
    }

    pub(crate) fn decode_persisted(
        catalog: &PlacementCatalog,
        bytes: &[u8],
    ) -> Result<Self, ProductStateStoreError> {
        let persisted: PersistedAggregate =
            serde_json::from_slice(bytes).map_err(|_| ProductStateStoreError::Corrupt)?;

        if persisted.schema_version != PRODUCT_PERSISTENCE_SCHEMA_VERSION {
            return Err(ProductStateStoreError::Corrupt);
        }

        let player = PlayerState::from_persistence_snapshot(persisted.player)
            .map_err(|_| ProductStateStoreError::Corrupt)?;

        let snapshot = RestaurantSnapshot {
            room: persisted.restaurant.room.into(),
            next_instance_id: persisted.restaurant.next_instance_id,
            items: persisted
                .restaurant
                .items
                .into_iter()
                .map(PlacedItem::from)
                .collect(),
        };
        let restaurant = RestaurantState::from_snapshot(catalog, snapshot)
            .map_err(|_| ProductStateStoreError::Corrupt)?;

        let authoritative_items: BTreeMap<_, _> = restaurant
            .items()
            .map(|item| (item.instance_id, *item))
            .collect();

        let mut placed_counts = BTreeMap::<u32, u32>::new();
        for item in authoritative_items.values() {
            let count = placed_counts.entry(item.item_id).or_default();
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

        let mut placement_mutations = BTreeMap::new();

        for entry in persisted.placement_mutations {
            let mutation_id =
                MutationId::new(entry.mutation_id).map_err(|_| ProductStateStoreError::Corrupt)?;
            let placed = PlacedItem::from(entry.item);

            if authoritative_items.get(&placed.instance_id) != Some(&placed)
                || placement_mutations.insert(mutation_id, placed).is_some()
            {
                return Err(ProductStateStoreError::Corrupt);
            }
        }

        if placement_mutations.len() != authoritative_items.len() {
            return Err(ProductStateStoreError::Corrupt);
        }

        Ok(Self {
            player,
            restaurant,
            placement_mutations,
        })
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
            let placed = self
                .restaurant
                .items()
                .filter(|item| item.item_id == *item_id)
                .count();
            let placed = u32::try_from(placed)
                .map_err(|_| ProductServiceError::Store(ProductStateStoreError::Corrupt))?;
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

        if let Some(existing) = self.placement_mutations.get(&mutation_id) {
            return Ok(PlacementMutationOutcome::Duplicate(*existing));
        }

        let owned = self.player.inventory().quantity(intent.item_id);
        let already_placed = self
            .restaurant
            .items()
            .filter(|placed| placed.item_id == intent.item_id)
            .count();

        if already_placed >= usize::try_from(owned).unwrap_or(usize::MAX) {
            return Err(ProductServiceError::ItemUnavailable {
                item_id: intent.item_id,
                owned,
                placed: u32::try_from(already_placed).unwrap_or(u32::MAX),
            });
        }

        let placed = self
            .restaurant
            .place(catalog, intent)
            .map_err(ProductServiceError::RestaurantAuthority)?;

        self.placement_mutations.insert(mutation_id, placed);
        Ok(PlacementMutationOutcome::Applied(placed))
    }

    pub fn restaurant_product_snapshot(
        &self,
        session: VerifiedProductSession,
    ) -> Result<RestaurantProductSnapshot, ProductServiceError> {
        self.require_subject(session)?;

        let restaurant = self.restaurant.snapshot();
        let mut placed_counts = BTreeMap::<u32, u32>::new();
        for item in &restaurant.items {
            let count = placed_counts.entry(item.item_id).or_default();
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
        Self {
            verifier,
            store,
            catalog,
            initial_room,
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
    ItemUnavailable {
        item_id: u32,
        owned: u32,
        placed: u32,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Command;
    use crate::placement::{Footprint, PlacementFlags, TilePoint};
    use crate::platform::{PRODUCT_ID, ProductSessionId};
    use crate::restaurant::ItemPlacementDefinition;

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
