use crate::domain::{AuthorityError, Command, MutationId, MutationOutcome, PlayerState};
use crate::platform::{
    AnewSubject, PlatformSessionError, PlatformSessionVerifier, VerifiedProductSession,
};
use crate::placement::RoomDimensions;
use crate::restaurant::{
    PlacedItem, PlacementCatalog, PlacementIntent, RestaurantAuthorityError, RestaurantSnapshot,
    RestaurantState,
};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlacementMutationOutcome {
    Applied(PlacedItem),
    Duplicate(PlacedItem),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductAggregate {
    player: PlayerState,
    restaurant: RestaurantState,
    placement_mutations: BTreeMap<MutationId, PlacedItem>,
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

    pub fn apply_player_command(
        &mut self,
        session: VerifiedProductSession,
        mutation_id: MutationId,
        command: Command,
    ) -> Result<MutationOutcome, ProductServiceError> {
        self.require_subject(session)?;
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

    pub fn restaurant_snapshot(
        &self,
        session: VerifiedProductSession,
    ) -> Result<RestaurantSnapshot, ProductServiceError> {
        self.require_subject(session)?;
        Ok(self.restaurant.snapshot())
    }

    fn require_subject(
        &self,
        session: VerifiedProductSession,
    ) -> Result<(), ProductServiceError> {
        if session.subject != self.subject() {
            return Err(ProductServiceError::SubjectMismatch);
        }
        Ok(())
    }
}

pub trait ProductStateStore {
    fn load(
        &self,
        subject: AnewSubject,
    ) -> Result<Option<ProductAggregate>, ProductStateStoreError>;

    fn save(&mut self, state: ProductAggregate) -> Result<(), ProductStateStoreError>;
}

#[derive(Clone, Debug, Default)]
pub struct InMemoryProductStateStore {
    states: BTreeMap<AnewSubject, ProductAggregate>,
}

impl ProductStateStore for InMemoryProductStateStore {
    fn load(
        &self,
        subject: AnewSubject,
    ) -> Result<Option<ProductAggregate>, ProductStateStoreError> {
        Ok(self.states.get(&subject).cloned())
    }

    fn save(&mut self, state: ProductAggregate) -> Result<(), ProductStateStoreError> {
        self.states.insert(state.subject(), state);
        Ok(())
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
        &mut self,
        bearer_token: &str,
        mutation_id: MutationId,
        command: Command,
    ) -> Result<MutationOutcome, ProductServiceError> {
        let session = self.verify(bearer_token)?;
        let mut state = self.load_or_initialize(session.subject)?;
        let outcome = state.apply_player_command(session, mutation_id, command)?;
        self.store
            .save(state)
            .map_err(ProductServiceError::Store)?;
        Ok(outcome)
    }

    pub fn place_item(
        &mut self,
        bearer_token: &str,
        mutation_id: MutationId,
        intent: PlacementIntent,
    ) -> Result<PlacementMutationOutcome, ProductServiceError> {
        let session = self.verify(bearer_token)?;
        let mut state = self.load_or_initialize(session.subject)?;
        let outcome =
            state.place_owned_item(session, &self.catalog, mutation_id, intent)?;
        self.store
            .save(state)
            .map_err(ProductServiceError::Store)?;
        Ok(outcome)
    }

    pub fn load_restaurant(
        &self,
        bearer_token: &str,
    ) -> Result<RestaurantSnapshot, ProductServiceError> {
        let session = self.verify(bearer_token)?;
        let state = self
            .store
            .load(session.subject)
            .map_err(ProductServiceError::Store)?
            .unwrap_or_else(|| ProductAggregate::new(session.subject, self.initial_room));
        state.restaurant_snapshot(session)
    }

    pub fn into_store(self) -> S {
        self.store
    }

    fn verify(
        &self,
        bearer_token: &str,
    ) -> Result<VerifiedProductSession, ProductServiceError> {
        self.verifier
            .verify_product_session(bearer_token)
            .map_err(ProductServiceError::Session)
    }

    fn load_or_initialize(
        &self,
        subject: AnewSubject,
    ) -> Result<ProductAggregate, ProductServiceError> {
        Ok(self
            .store
            .load(subject)
            .map_err(ProductServiceError::Store)?
            .unwrap_or_else(|| ProductAggregate::new(subject, self.initial_room)))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProductStateStoreError {
    Unavailable,
    Corrupt,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProductServiceError {
    Session(PlatformSessionError),
    Store(ProductStateStoreError),
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
    use crate::platform::{ProductSessionId, PRODUCT_ID};
    use crate::placement::{Footprint, PlacementFlags, TilePoint};
    use crate::restaurant::ItemPlacementDefinition;

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
            if bearer_token != "valid-product-session" {
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

    fn service() -> RestaurantProductService<FakeVerifier, InMemoryProductStateStore> {
        let verifier = FakeVerifier {
            subject: subject(7),
            session_id: ProductSessionId::from_verified_platform_bytes([9; 16]).unwrap(),
        };
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
            verifier,
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

    #[test]
    fn invalid_platform_session_cannot_read_or_mutate_product_state() {
        let mut service = service();

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
        let mut service = service();

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
        let mut service = service();
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

        let snapshot = service
            .load_restaurant("valid-product-session")
            .unwrap();
        assert_eq!(snapshot.items, vec![placed]);
    }

    #[test]
    fn owned_quantity_limits_simultaneous_placements() {
        let mut service = service();
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
        let snapshot = service
            .load_restaurant("valid-product-session")
            .unwrap();

        assert!(snapshot.items.is_empty());
        assert_eq!(snapshot.room.inside_x, 8);
        assert_eq!(snapshot.room.inside_y, 8);
    }
}
