use crate::placement::{
    Footprint, PlacementFlags, PlacementShape, RoomDimensions, StructuralPlacement, TilePoint,
    rotate_footprint, validate_structural_placement,
};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ItemPlacementDefinition {
    pub item_id: u32,
    pub footprint: Footprint,
    /// Historical RoomItem.content.totalFrames. The original client cycles
    /// rotation by advancing the content MovieClip one frame at a time.
    pub rotation_count: u8,
    pub flags: PlacementFlags,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PlacementCatalog {
    definitions: BTreeMap<u32, ItemPlacementDefinition>,
}

pub const PLACEMENT_CATALOG_MAGIC: &str = "ANEWON_RC_PLACEMENT_CATALOG_V2";
const PLACEMENT_CATALOG_COLUMNS: &str = "item_id\tsize_x\tsize_y\trotation_count\twall_item\twall_decoration_item\twallpaper_item\toutdoor\tfloor_tile_item";

impl PlacementCatalog {
    pub fn new(
        definitions: impl IntoIterator<Item = ItemPlacementDefinition>,
    ) -> Result<Self, RestaurantAuthorityError> {
        let mut catalog = Self::default();
        for definition in definitions {
            if definition.footprint.size_x == 0
                || definition.footprint.size_y == 0
                || definition.rotation_count == 0
                || definition.rotation_count > 16
            {
                return Err(RestaurantAuthorityError::InvalidDefinition {
                    item_id: definition.item_id,
                });
            }
            if catalog
                .definitions
                .insert(definition.item_id, definition)
                .is_some()
            {
                return Err(RestaurantAuthorityError::DuplicateDefinition {
                    item_id: definition.item_id,
                });
            }
        }
        Ok(catalog)
    }

    pub fn get(&self, item_id: u32) -> Option<&ItemPlacementDefinition> {
        self.definitions.get(&item_id)
    }

    pub fn from_trusted_tsv(input: &str) -> Result<Self, PlacementCatalogLoadError> {
        let mut lines = input.lines().enumerate();
        let Some((_, magic)) = lines.next() else {
            return Err(PlacementCatalogLoadError::MissingMagic);
        };
        if magic.trim() != PLACEMENT_CATALOG_MAGIC {
            return Err(PlacementCatalogLoadError::MissingMagic);
        }

        let mut saw_columns = false;
        let mut definitions = Vec::new();

        for (index, raw) in lines {
            let line_number = index + 1;
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }

            if !saw_columns {
                if line != PLACEMENT_CATALOG_COLUMNS {
                    return Err(PlacementCatalogLoadError::InvalidColumns { line: line_number });
                }
                saw_columns = true;
                continue;
            }

            let fields: Vec<_> = line.split('\t').collect();
            if fields.len() != 9 {
                return Err(PlacementCatalogLoadError::InvalidRow { line: line_number });
            }

            let parse_u32 = |value: &str| {
                value
                    .parse::<u32>()
                    .map_err(|_| PlacementCatalogLoadError::InvalidRow { line: line_number })
            };
            let parse_u8 = |value: &str| {
                value
                    .parse::<u8>()
                    .map_err(|_| PlacementCatalogLoadError::InvalidRow { line: line_number })
            };
            let parse_bool = |value: &str| match value {
                "0" => Ok(false),
                "1" => Ok(true),
                _ => Err(PlacementCatalogLoadError::InvalidRow { line: line_number }),
            };

            definitions.push(ItemPlacementDefinition {
                item_id: parse_u32(fields[0])?,
                footprint: Footprint {
                    size_x: parse_u32(fields[1])?,
                    size_y: parse_u32(fields[2])?,
                },
                rotation_count: parse_u8(fields[3])?,
                flags: PlacementFlags {
                    wall_item: parse_bool(fields[4])?,
                    wall_decoration_item: parse_bool(fields[5])?,
                    wallpaper_item: parse_bool(fields[6])?,
                    outdoor: parse_bool(fields[7])?,
                    floor_tile_item: parse_bool(fields[8])?,
                },
            });
        }

        if !saw_columns {
            return Err(PlacementCatalogLoadError::InvalidColumns { line: 1 });
        }

        Self::new(definitions).map_err(PlacementCatalogLoadError::Definition)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PlacementIntent {
    pub item_id: u32,
    pub tile: TilePoint,
    pub rotation: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PlacedItem {
    pub instance_id: u64,
    pub item_id: u32,
    pub tile: TilePoint,
    pub rotation: u8,
    pub room_index: u8,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RestaurantSnapshot {
    pub room: RoomDimensions,
    pub next_instance_id: u64,
    pub items: Vec<PlacedItem>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RestaurantState {
    room: RoomDimensions,
    next_instance_id: u64,
    items: BTreeMap<u64, PlacedItem>,
}

impl RestaurantState {
    pub fn new(room: RoomDimensions) -> Self {
        Self {
            room,
            next_instance_id: 1,
            items: BTreeMap::new(),
        }
    }

    pub fn room(&self) -> RoomDimensions {
        self.room
    }

    pub fn items(&self) -> impl Iterator<Item = &PlacedItem> {
        self.items.values()
    }

    pub fn place(
        &mut self,
        catalog: &PlacementCatalog,
        intent: PlacementIntent,
    ) -> Result<PlacedItem, RestaurantAuthorityError> {
        let definition =
            *catalog
                .get(intent.item_id)
                .ok_or(RestaurantAuthorityError::UnknownItem {
                    item_id: intent.item_id,
                })?;

        let placed = self.validate_new_item(catalog, definition, intent, self.next_instance_id)?;

        self.next_instance_id = self
            .next_instance_id
            .checked_add(1)
            .ok_or(RestaurantAuthorityError::InstanceIdExhausted)?;
        self.items.insert(placed.instance_id, placed);
        Ok(placed)
    }

    pub fn snapshot(&self) -> RestaurantSnapshot {
        RestaurantSnapshot {
            room: self.room,
            next_instance_id: self.next_instance_id,
            items: self.items.values().copied().collect(),
        }
    }

    pub fn from_snapshot(
        catalog: &PlacementCatalog,
        snapshot: RestaurantSnapshot,
    ) -> Result<Self, RestaurantAuthorityError> {
        let mut state = Self {
            room: snapshot.room,
            next_instance_id: 1,
            items: BTreeMap::new(),
        };

        let mut max_instance_id = 0_u64;
        for stored in snapshot.items {
            if stored.instance_id == 0 || state.items.contains_key(&stored.instance_id) {
                return Err(RestaurantAuthorityError::InvalidSnapshotInstanceId {
                    instance_id: stored.instance_id,
                });
            }

            let definition =
                *catalog
                    .get(stored.item_id)
                    .ok_or(RestaurantAuthorityError::UnknownItem {
                        item_id: stored.item_id,
                    })?;
            let intent = PlacementIntent {
                item_id: stored.item_id,
                tile: stored.tile,
                rotation: stored.rotation,
            };
            let validated =
                state.validate_new_item(catalog, definition, intent, stored.instance_id)?;

            if validated.room_index != stored.room_index {
                return Err(RestaurantAuthorityError::SnapshotRoomMismatch {
                    instance_id: stored.instance_id,
                });
            }

            max_instance_id = max_instance_id.max(stored.instance_id);
            state.items.insert(stored.instance_id, stored);
        }

        if snapshot.next_instance_id == 0 || snapshot.next_instance_id <= max_instance_id {
            return Err(RestaurantAuthorityError::InvalidNextInstanceId {
                value: snapshot.next_instance_id,
            });
        }

        state.next_instance_id = snapshot.next_instance_id;
        Ok(state)
    }

    fn validate_new_item(
        &self,
        catalog: &PlacementCatalog,
        definition: ItemPlacementDefinition,
        intent: PlacementIntent,
        instance_id: u64,
    ) -> Result<PlacedItem, RestaurantAuthorityError> {
        if intent.rotation >= definition.rotation_count {
            return Err(RestaurantAuthorityError::InvalidRotation {
                rotation: intent.rotation,
            });
        }

        // The first M2 authoritative slice only permits ordinary floor-space
        // items. Wall/floor-tile domains require their recovered collision maps
        // before they can be accepted safely.
        if definition.flags.wall_item
            || definition.flags.wall_decoration_item
            || definition.flags.wallpaper_item
            || definition.flags.floor_tile_item
        {
            return Err(RestaurantAuthorityError::UnsupportedPlacementDomain {
                item_id: definition.item_id,
            });
        }

        let footprint = rotate_footprint(definition.footprint, i32::from(intent.rotation));
        let shape = PlacementShape {
            footprint,
            flags: definition.flags,
        };

        let room_index = match validate_structural_placement(shape, intent.tile, self.room) {
            StructuralPlacement::Valid { room_index } => room_index,
            reason => {
                return Err(RestaurantAuthorityError::StructuralPlacement {
                    item_id: definition.item_id,
                    reason,
                });
            }
        };

        for existing in self.items.values() {
            if existing.room_index != room_index {
                continue;
            }

            let existing_definition =
                *catalog
                    .get(existing.item_id)
                    .ok_or(RestaurantAuthorityError::UnknownItem {
                        item_id: existing.item_id,
                    })?;
            let existing_footprint =
                rotate_footprint(existing_definition.footprint, i32::from(existing.rotation));

            if rectangles_overlap(intent.tile, footprint, existing.tile, existing_footprint) {
                return Err(RestaurantAuthorityError::Collision {
                    item_id: definition.item_id,
                    with_instance_id: existing.instance_id,
                });
            }
        }

        Ok(PlacedItem {
            instance_id,
            item_id: intent.item_id,
            tile: intent.tile,
            rotation: intent.rotation,
            room_index,
        })
    }
}

fn rectangles_overlap(a_tile: TilePoint, a: Footprint, b_tile: TilePoint, b: Footprint) -> bool {
    let a_max_x = i64::from(a_tile.x) + i64::from(a.size_x) - 1;
    let a_max_y = i64::from(a_tile.y) + i64::from(a.size_y) - 1;
    let b_max_x = i64::from(b_tile.x) + i64::from(b.size_x) - 1;
    let b_max_y = i64::from(b_tile.y) + i64::from(b.size_y) - 1;

    i64::from(a_tile.x) <= b_max_x
        && a_max_x >= i64::from(b_tile.x)
        && i64::from(a_tile.y) <= b_max_y
        && a_max_y >= i64::from(b_tile.y)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlacementCatalogLoadError {
    MissingMagic,
    InvalidColumns { line: usize },
    InvalidRow { line: usize },
    Definition(RestaurantAuthorityError),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RestaurantAuthorityError {
    UnknownItem {
        item_id: u32,
    },
    DuplicateDefinition {
        item_id: u32,
    },
    InvalidDefinition {
        item_id: u32,
    },
    InvalidRotation {
        rotation: u8,
    },
    UnsupportedPlacementDomain {
        item_id: u32,
    },
    StructuralPlacement {
        item_id: u32,
        reason: StructuralPlacement,
    },
    Collision {
        item_id: u32,
        with_instance_id: u64,
    },
    InstanceIdExhausted,
    InvalidSnapshotInstanceId {
        instance_id: u64,
    },
    SnapshotRoomMismatch {
        instance_id: u64,
    },
    InvalidNextInstanceId {
        value: u64,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room() -> RoomDimensions {
        RoomDimensions {
            inside_x: 8,
            inside_y: 8,
            outside_x: 0,
            outside_y: 0,
        }
    }

    fn catalog() -> PlacementCatalog {
        PlacementCatalog::new([
            ItemPlacementDefinition {
                item_id: 10,
                footprint: Footprint {
                    size_x: 2,
                    size_y: 1,
                },
                rotation_count: 4,
                flags: PlacementFlags::default(),
            },
            ItemPlacementDefinition {
                item_id: 20,
                footprint: Footprint {
                    size_x: 1,
                    size_y: 1,
                },
                rotation_count: 1,
                flags: PlacementFlags::default(),
            },
        ])
        .unwrap()
    }

    #[test]
    fn trusted_catalog_loader_accepts_generated_contract() {
        let input = concat!(
            "ANEWON_RC_PLACEMENT_CATALOG_V2\n",
            "# baseline=0.9.143a\n",
            "item_id\tsize_x\tsize_y\trotation_count\twall_item\twall_decoration_item\twallpaper_item\toutdoor\tfloor_tile_item\n",
            "10\t2\t1\t4\t0\t0\t0\t0\t0\n",
            "20\t1\t1\t1\t0\t0\t0\t0\t0\n",
        );
        let catalog = PlacementCatalog::from_trusted_tsv(input).unwrap();
        assert_eq!(catalog.get(10).unwrap().footprint.size_x, 2);
        assert_eq!(catalog.get(20).unwrap().footprint.size_y, 1);
    }

    #[test]
    fn trusted_catalog_loader_rejects_duplicate_ids() {
        let input = concat!(
            "ANEWON_RC_PLACEMENT_CATALOG_V2\n",
            "item_id\tsize_x\tsize_y\trotation_count\twall_item\twall_decoration_item\twallpaper_item\toutdoor\tfloor_tile_item\n",
            "10\t2\t1\t4\t0\t0\t0\t0\t0\n",
            "10\t1\t1\t4\t0\t0\t0\t0\t0\n",
        );
        assert_eq!(
            PlacementCatalog::from_trusted_tsv(input).unwrap_err(),
            PlacementCatalogLoadError::Definition(RestaurantAuthorityError::DuplicateDefinition {
                item_id: 10
            })
        );
    }

    #[test]
    fn server_resolves_shape_from_catalog_not_client_payload() {
        let mut state = RestaurantState::new(room());
        let placed = state
            .place(
                &catalog(),
                PlacementIntent {
                    item_id: 10,
                    tile: TilePoint { x: 2, y: 2 },
                    rotation: 1,
                },
            )
            .unwrap();

        assert_eq!(placed.instance_id, 1);
        assert_eq!(placed.rotation, 1);
        assert_eq!(state.snapshot().next_instance_id, 2);
    }

    #[test]
    fn rotated_footprint_is_used_for_bounds_validation() {
        let mut state = RestaurantState::new(room());
        let error = state
            .place(
                &catalog(),
                PlacementIntent {
                    item_id: 10,
                    tile: TilePoint { x: 7, y: 7 },
                    rotation: 1,
                },
            )
            .unwrap_err();

        assert_eq!(
            error,
            RestaurantAuthorityError::StructuralPlacement {
                item_id: 10,
                reason: StructuralPlacement::OutOfBounds,
            }
        );
    }

    #[test]
    fn overlapping_ordinary_items_are_rejected() {
        let mut state = RestaurantState::new(room());
        state
            .place(
                &catalog(),
                PlacementIntent {
                    item_id: 10,
                    tile: TilePoint { x: 2, y: 2 },
                    rotation: 0,
                },
            )
            .unwrap();

        assert_eq!(
            state
                .place(
                    &catalog(),
                    PlacementIntent {
                        item_id: 20,
                        tile: TilePoint { x: 3, y: 2 },
                        rotation: 0,
                    },
                )
                .unwrap_err(),
            RestaurantAuthorityError::Collision {
                item_id: 20,
                with_instance_id: 1,
            }
        );
    }

    #[test]
    fn recovered_frame_count_limits_rotation_per_item() {
        let mut state = RestaurantState::new(room());

        assert_eq!(
            state
                .place(
                    &catalog(),
                    PlacementIntent {
                        item_id: 20,
                        tile: TilePoint { x: 2, y: 2 },
                        rotation: 1,
                    },
                )
                .unwrap_err(),
            RestaurantAuthorityError::InvalidRotation { rotation: 1 }
        );
    }

    #[test]
    fn snapshot_round_trip_revalidates_layout() {
        let catalog = catalog();
        let mut state = RestaurantState::new(room());
        state
            .place(
                &catalog,
                PlacementIntent {
                    item_id: 20,
                    tile: TilePoint { x: 2, y: 2 },
                    rotation: 0,
                },
            )
            .unwrap();

        let snapshot = state.snapshot();
        let restored = RestaurantState::from_snapshot(&catalog, snapshot.clone()).unwrap();

        assert_eq!(restored.snapshot(), snapshot);
    }

    #[test]
    fn tampered_snapshot_room_index_is_rejected() {
        let catalog = catalog();
        let snapshot = RestaurantSnapshot {
            room: room(),
            next_instance_id: 2,
            items: vec![PlacedItem {
                instance_id: 1,
                item_id: 20,
                tile: TilePoint { x: 2, y: 2 },
                rotation: 0,
                room_index: 1,
            }],
        };

        assert_eq!(
            RestaurantState::from_snapshot(&catalog, snapshot).unwrap_err(),
            RestaurantAuthorityError::SnapshotRoomMismatch { instance_id: 1 }
        );
    }
}
