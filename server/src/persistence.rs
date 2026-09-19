use crate::platform::AnewSubject;
use crate::restaurant::PlacementCatalog;
use crate::service::{
    LoadedProductState, ProductAggregate, ProductStateStore, ProductStateStoreError,
};
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};
use std::path::Path;

const STATE_TABLE: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("restaurant_city_product_state_v1");
const RECORD_MAGIC: &[u8; 5] = b"RCP01";
const RECORD_HEADER_BYTES: usize = RECORD_MAGIC.len() + 8;

pub struct RedbProductStateStore {
    database: Database,
    catalog: PlacementCatalog,
}

impl RedbProductStateStore {
    pub fn open(
        path: impl AsRef<Path>,
        catalog: PlacementCatalog,
    ) -> Result<Self, ProductStateStoreError> {
        let database =
            Database::create(path.as_ref()).map_err(|_| ProductStateStoreError::Unavailable)?;

        let write = database
            .begin_write()
            .map_err(|_| ProductStateStoreError::Unavailable)?;
        {
            write
                .open_table(STATE_TABLE)
                .map_err(|_| ProductStateStoreError::Unavailable)?;
        }
        write
            .commit()
            .map_err(|_| ProductStateStoreError::Unavailable)?;

        Ok(Self { database, catalog })
    }

    fn decode_record(
        &self,
        subject: AnewSubject,
        record: &[u8],
    ) -> Result<(u64, ProductAggregate), ProductStateStoreError> {
        if record.len() < RECORD_HEADER_BYTES || &record[..RECORD_MAGIC.len()] != RECORD_MAGIC {
            return Err(ProductStateStoreError::Corrupt);
        }

        let revision_start = RECORD_MAGIC.len();
        let revision_end = revision_start + 8;
        let revision = u64::from_be_bytes(
            record[revision_start..revision_end]
                .try_into()
                .map_err(|_| ProductStateStoreError::Corrupt)?,
        );
        if revision == 0 {
            return Err(ProductStateStoreError::Corrupt);
        }

        let state = ProductAggregate::decode_persisted(&self.catalog, &record[revision_end..])?;
        if state.subject() != subject {
            return Err(ProductStateStoreError::Corrupt);
        }

        Ok((revision, state))
    }
}

impl ProductStateStore for RedbProductStateStore {
    fn load(
        &self,
        subject: AnewSubject,
    ) -> Result<Option<LoadedProductState>, ProductStateStoreError> {
        let read = self
            .database
            .begin_read()
            .map_err(|_| ProductStateStoreError::Unavailable)?;
        let table = read
            .open_table(STATE_TABLE)
            .map_err(|_| ProductStateStoreError::Unavailable)?;

        let Some(record) = table
            .get(&subject.as_bytes()[..])
            .map_err(|_| ProductStateStoreError::Unavailable)?
        else {
            return Ok(None);
        };

        let (store_revision, state) = self.decode_record(subject, record.value())?;
        Ok(Some(LoadedProductState {
            store_revision,
            state,
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

        let payload = state.encode_persisted()?;
        let write = self
            .database
            .begin_write()
            .map_err(|_| ProductStateStoreError::Unavailable)?;

        let next_revision;
        {
            let mut table = write
                .open_table(STATE_TABLE)
                .map_err(|_| ProductStateStoreError::Unavailable)?;

            let current_revision = match table
                .get(&subject.as_bytes()[..])
                .map_err(|_| ProductStateStoreError::Unavailable)?
            {
                Some(record) => {
                    let (revision, _) = self.decode_record(subject, record.value())?;
                    Some(revision)
                }
                None => None,
            };

            if current_revision != expected_revision {
                return Err(ProductStateStoreError::Conflict);
            }

            next_revision = current_revision
                .unwrap_or(0)
                .checked_add(1)
                .ok_or(ProductStateStoreError::Corrupt)?;

            let mut record = Vec::with_capacity(RECORD_HEADER_BYTES + payload.len());
            record.extend_from_slice(RECORD_MAGIC);
            record.extend_from_slice(&next_revision.to_be_bytes());
            record.extend_from_slice(&payload);

            table
                .insert(&subject.as_bytes()[..], record.as_slice())
                .map_err(|_| ProductStateStoreError::Unavailable)?;
        }

        write
            .commit()
            .map_err(|_| ProductStateStoreError::Unavailable)?;
        Ok(next_revision)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::active_service::ActiveServiceAssignment;
    use crate::domain::{Command, MutationId};
    use crate::gameplay::ServiceLoopEvent;
    use crate::placement::{Footprint, PlacementFlags, RoomDimensions, TilePoint};
    use crate::platform::{ProductSessionId, VerifiedProductSession};
    use crate::restaurant::{ItemPlacementDefinition, PlacementIntent};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_DB_ID: AtomicU64 = AtomicU64::new(1);

    fn temp_database() -> PathBuf {
        let id = NEXT_DB_ID.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "anewon-restaurant-city-{}-{id}.redb",
            std::process::id()
        ))
    }

    fn subject() -> AnewSubject {
        AnewSubject::from_verified_platform_bytes([7; 16]).unwrap()
    }

    fn session() -> VerifiedProductSession {
        VerifiedProductSession {
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

    fn active_service_aggregate() -> ProductAggregate {
        let catalog = active_service_catalog();
        let mut aggregate = ProductAggregate::new(
            subject(),
            RoomDimensions {
                inside_x: 8,
                inside_y: 8,
                outside_x: 0,
                outside_y: 0,
            },
        );
        for (item_id, grant, place, tile) in [
            (
                11_u32,
                "grant-chair",
                "place-chair",
                TilePoint { x: 2, y: 2 },
            ),
            (
                12_u32,
                "grant-table",
                "place-table",
                TilePoint { x: 3, y: 2 },
            ),
            (
                13_u32,
                "grant-kitchen",
                "place-kitchen",
                TilePoint { x: 6, y: 4 },
            ),
        ] {
            aggregate
                .apply_player_command(
                    session(),
                    MutationId::new(grant.to_owned()).unwrap(),
                    Command::GrantInventory {
                        item_id,
                        quantity: 1,
                    },
                )
                .unwrap();
            aggregate
                .place_owned_item(
                    session(),
                    &catalog,
                    MutationId::new(place.to_owned()).unwrap(),
                    PlacementIntent {
                        item_id,
                        tile,
                        rotation: 0,
                    },
                )
                .unwrap();
        }

        aggregate
            .start_active_service(
                session(),
                &catalog,
                MutationId::new("service-start".to_owned()).unwrap(),
                ActiveServiceAssignment {
                    chair_instance_id: 1,
                    table_instance_id: 2,
                    chef_employee_id: 101,
                    kitchen_instance_id: 3,
                    waiter_employee_id: 201,
                    waiter_tile: TilePoint { x: 4, y: 4 },
                },
            )
            .unwrap();
        aggregate
            .transition_active_service(
                session(),
                MutationId::new("service-walk".to_owned()).unwrap(),
                1,
                ServiceLoopEvent::StartChairWalk,
            )
            .unwrap();
        aggregate
            .transition_active_service(
                session(),
                MutationId::new("service-chair".to_owned()).unwrap(),
                1,
                ServiceLoopEvent::ReachChair,
            )
            .unwrap();
        aggregate
    }

    fn aggregate() -> ProductAggregate {
        let catalog = catalog();
        let mut aggregate = ProductAggregate::new(
            subject(),
            RoomDimensions {
                inside_x: 8,
                inside_y: 8,
                outside_x: 0,
                outside_y: 0,
            },
        );
        aggregate
            .apply_player_command(
                session(),
                MutationId::new("grant-1".to_owned()).unwrap(),
                Command::GrantInventory {
                    item_id: 10,
                    quantity: 1,
                },
            )
            .unwrap();
        aggregate
            .place_owned_item(
                session(),
                &catalog,
                MutationId::new("place-1".to_owned()).unwrap(),
                PlacementIntent {
                    item_id: 10,
                    tile: TilePoint { x: 2, y: 2 },
                    rotation: 0,
                },
            )
            .unwrap();
        aggregate
    }

    #[test]
    fn state_survives_store_reopen() {
        let path = temp_database();
        let catalog = catalog();
        let expected = aggregate();

        {
            let store = RedbProductStateStore::open(&path, catalog.clone()).unwrap();
            assert_eq!(
                store
                    .compare_and_swap(subject(), None, expected.clone())
                    .unwrap(),
                1
            );
        }

        {
            let store = RedbProductStateStore::open(&path, catalog).unwrap();
            let loaded = store.load(subject()).unwrap().unwrap();
            assert_eq!(loaded.store_revision, 1);
            assert_eq!(loaded.state, expected);
        }

        let _ = fs::remove_file(path);
    }

    #[test]
    fn active_service_survives_database_reopen_and_continues_from_reducer_state() {
        let path = temp_database();
        let catalog = active_service_catalog();
        let expected = active_service_aggregate();

        {
            let store = RedbProductStateStore::open(&path, catalog.clone()).unwrap();
            assert_eq!(
                store
                    .compare_and_swap(subject(), None, expected.clone())
                    .unwrap(),
                1
            );
        }

        let resumed;
        {
            let store = RedbProductStateStore::open(&path, catalog.clone()).unwrap();
            let loaded = store.load(subject()).unwrap().unwrap();
            assert_eq!(loaded.store_revision, 1);
            assert_eq!(loaded.state, expected);

            let mut state = loaded.state;
            state
                .transition_active_service(
                    session(),
                    MutationId::new("service-decision".to_owned()).unwrap(),
                    1,
                    ServiceLoopEvent::DecisionElapsed,
                )
                .unwrap();
            assert_eq!(
                store
                    .compare_and_swap(subject(), Some(1), state.clone())
                    .unwrap(),
                2
            );
            resumed = state;
        }

        {
            let store = RedbProductStateStore::open(&path, catalog).unwrap();
            let loaded = store.load(subject()).unwrap().unwrap();
            assert_eq!(loaded.store_revision, 2);
            assert_eq!(loaded.state, resumed);
            assert_eq!(
                loaded.state.active_service().unwrap().state.customer,
                crate::gameplay::CustomerServiceState::Waiting
            );
        }

        let _ = fs::remove_file(path);
    }

    #[test]
    fn stale_compare_and_swap_is_rejected() {
        let path = temp_database();
        let catalog = catalog();
        let expected = aggregate();
        let store = RedbProductStateStore::open(&path, catalog).unwrap();

        assert_eq!(
            store
                .compare_and_swap(subject(), None, expected.clone())
                .unwrap(),
            1
        );
        assert_eq!(
            store.compare_and_swap(subject(), None, expected),
            Err(ProductStateStoreError::Conflict)
        );

        drop(store);
        let _ = fs::remove_file(path);
    }
}
