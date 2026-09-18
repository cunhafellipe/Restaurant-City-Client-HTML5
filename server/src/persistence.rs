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
    use crate::domain::{Command, MutationId};
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
