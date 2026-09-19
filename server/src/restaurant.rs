use crate::placement::{
    Footprint, HistoricalTileStackEntry, HistoricalTileStackValidation, PlacementFlags,
    PlacementShape, ROOM_INDEX_MAIN, RoomDimensions, StructuralPlacement, TilePoint,
    default_wall_attachment_rotation, rotate_footprint, validate_historical_tile_stack,
    validate_structural_placement,
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

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ServiceItemFlags {
    pub door_item: bool,
    pub chair_item: bool,
    pub table_item: bool,
    pub kitchen: bool,
    pub drink: bool,
    pub toilet: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PlacementCatalog {
    definitions: BTreeMap<u32, ItemPlacementDefinition>,
    service_roles: BTreeMap<u32, ServiceItemFlags>,
    occupied_cells: BTreeMap<(u32, u8), Vec<TilePoint>>,
}

pub const PLACEMENT_CATALOG_MAGIC: &str = "ANEWON_RC_PLACEMENT_CATALOG_V4";
const PLACEMENT_CATALOG_COLUMNS: &str = "item_id\tsize_x\tsize_y\trotation_count\twall_item\twall_decoration_item\twallpaper_item\toutdoor\tfloor_tile_item\tsurface\tstackable\tdoor_item\tchair_item\ttable_item\tkitchen\tdrink\ttoilet\toccupied_cells";

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

    pub fn service_flags(&self, item_id: u32) -> ServiceItemFlags {
        self.service_roles
            .get(&item_id)
            .copied()
            .unwrap_or_default()
    }

    pub fn occupied_cells(&self, item_id: u32, rotation: u8) -> Option<Vec<TilePoint>> {
        let definition = *self.get(item_id)?;
        if rotation >= definition.rotation_count {
            return None;
        }
        if let Some(cells) = self.occupied_cells.get(&(item_id, rotation)) {
            return Some(cells.clone());
        }

        let footprint = rotate_footprint(definition.footprint, i32::from(rotation));
        let mut cells = Vec::with_capacity((footprint.size_x * footprint.size_y) as usize);
        for y in 0..footprint.size_y {
            for x in 0..footprint.size_x {
                cells.push(TilePoint {
                    x: x as i32,
                    y: y as i32,
                });
            }
        }
        Some(cells)
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
        let mut service_roles = BTreeMap::new();
        let mut occupied_cells = BTreeMap::new();

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
            if fields.len() != 18 {
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

            let definition = ItemPlacementDefinition {
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
                    surface: parse_bool(fields[9])?,
                    stackable: parse_bool(fields[10])?,
                },
            };
            let service = ServiceItemFlags {
                door_item: parse_bool(fields[11])?,
                chair_item: parse_bool(fields[12])?,
                table_item: parse_bool(fields[13])?,
                kitchen: parse_bool(fields[14])?,
                drink: parse_bool(fields[15])?,
                toilet: parse_bool(fields[16])?,
            };

            if fields[17] != "-" {
                let rotations: Vec<_> = fields[17].split('/').collect();
                if rotations.len() != usize::from(definition.rotation_count) {
                    return Err(PlacementCatalogLoadError::InvalidRow { line: line_number });
                }
                for (rotation, encoded) in rotations.iter().enumerate() {
                    if encoded.is_empty() {
                        return Err(PlacementCatalogLoadError::InvalidRow { line: line_number });
                    }
                    let mut cells = Vec::new();
                    for token in encoded.split('+') {
                        let Some((x, y)) = token.split_once(',') else {
                            return Err(PlacementCatalogLoadError::InvalidRow {
                                line: line_number,
                            });
                        };
                        let x = x.parse::<i32>().map_err(|_| {
                            PlacementCatalogLoadError::InvalidRow { line: line_number }
                        })?;
                        let y = y.parse::<i32>().map_err(|_| {
                            PlacementCatalogLoadError::InvalidRow { line: line_number }
                        })?;
                        let tile = TilePoint { x, y };
                        if cells.contains(&tile) {
                            return Err(PlacementCatalogLoadError::InvalidRow {
                                line: line_number,
                            });
                        }
                        cells.push(tile);
                    }
                    if cells.is_empty() || !cells.contains(&TilePoint { x: 0, y: 0 }) {
                        return Err(PlacementCatalogLoadError::InvalidRow { line: line_number });
                    }
                    occupied_cells.insert((definition.item_id, rotation as u8), cells);
                }
            }

            service_roles.insert(definition.item_id, service);
            definitions.push(definition);
        }

        if !saw_columns {
            return Err(PlacementCatalogLoadError::InvalidColumns { line: 1 });
        }

        let mut catalog = Self::new(definitions).map_err(PlacementCatalogLoadError::Definition)?;
        catalog.service_roles = service_roles;
        catalog.occupied_cells = occupied_cells;
        Ok(catalog)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PlacementIntent {
    pub item_id: u32,
    pub tile: TilePoint,
    pub rotation: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FloorTileIntent {
    pub item_id: u32,
    pub tile: TilePoint,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PaintedFloorTile {
    pub item_id: u32,
    pub tile: TilePoint,
    pub room_index: u8,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum WallpaperOrientation {
    Left,
    Top,
}

impl WallpaperOrientation {
    pub const fn rotation(self) -> u8 {
        match self {
            Self::Left => 0,
            Self::Top => 1,
        }
    }

    pub const fn from_rotation(rotation: u8) -> Option<Self> {
        match rotation {
            0 => Some(Self::Left),
            1 => Some(Self::Top),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WallpaperIntent {
    pub item_id: u32,
    pub wall_tile: TilePoint,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AppliedWallpaper {
    pub item_id: u32,
    pub orientation: WallpaperOrientation,
}

pub fn validate_wallpaper_intent(
    catalog: &PlacementCatalog,
    room: RoomDimensions,
    intent: WallpaperIntent,
) -> Result<AppliedWallpaper, RestaurantAuthorityError> {
    let definition = *catalog
        .get(intent.item_id)
        .ok_or(RestaurantAuthorityError::UnknownItem {
            item_id: intent.item_id,
        })?;

    if !definition.flags.wallpaper_item {
        return Err(RestaurantAuthorityError::NotWallpaper {
            item_id: definition.item_id,
        });
    }
    if definition.footprint
        != (Footprint {
            size_x: 1,
            size_y: 1,
        })
    {
        return Err(RestaurantAuthorityError::UnsupportedWallpaperFootprint {
            item_id: definition.item_id,
        });
    }

    let rotation = default_wall_attachment_rotation(intent.wall_tile, room).ok_or(
        RestaurantAuthorityError::NoWallpaperTarget {
            item_id: definition.item_id,
            tile: intent.wall_tile,
        },
    )?;
    let orientation = WallpaperOrientation::from_rotation(rotation).ok_or(
        RestaurantAuthorityError::NoWallpaperTarget {
            item_id: definition.item_id,
            tile: intent.wall_tile,
        },
    )?;
    if rotation >= definition.rotation_count {
        return Err(RestaurantAuthorityError::InvalidDefinition {
            item_id: definition.item_id,
        });
    }

    Ok(AppliedWallpaper {
        item_id: definition.item_id,
        orientation,
    })
}

pub fn validate_floor_tile_intent(
    catalog: &PlacementCatalog,
    room: RoomDimensions,
    intent: FloorTileIntent,
) -> Result<PaintedFloorTile, RestaurantAuthorityError> {
    let definition = *catalog
        .get(intent.item_id)
        .ok_or(RestaurantAuthorityError::UnknownItem {
            item_id: intent.item_id,
        })?;

    if !definition.flags.floor_tile_item {
        return Err(RestaurantAuthorityError::NotFloorTile {
            item_id: definition.item_id,
        });
    }

    if definition.footprint
        != (Footprint {
            size_x: 1,
            size_y: 1,
        })
    {
        return Err(RestaurantAuthorityError::UnsupportedFloorTileFootprint {
            item_id: definition.item_id,
        });
    }

    let shape = PlacementShape {
        footprint: definition.footprint,
        flags: definition.flags,
    };
    let room_index = match validate_structural_placement(shape, intent.tile, room) {
        StructuralPlacement::Valid { room_index } => room_index,
        reason => {
            return Err(RestaurantAuthorityError::StructuralPlacement {
                item_id: definition.item_id,
                reason,
            });
        }
    };

    Ok(PaintedFloorTile {
        item_id: definition.item_id,
        tile: intent.tile,
        room_index,
    })
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
    // Historical WorldRestaurant.itemMap ordering is bottom -> top. Keep that
    // ordering explicitly; instance ids identify objects but a transform
    // removes/re-adds an object and therefore makes it the newest/top entry.
    stack_order: Vec<u64>,
}

impl RestaurantState {
    pub fn new(room: RoomDimensions) -> Self {
        Self {
            room,
            next_instance_id: 1,
            items: BTreeMap::new(),
            stack_order: Vec::new(),
        }
    }

    pub fn room(&self) -> RoomDimensions {
        self.room
    }

    pub fn items(&self) -> impl Iterator<Item = &PlacedItem> {
        self.stack_order
            .iter()
            .filter_map(|instance_id| self.items.get(instance_id))
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

        let placed =
            self.validate_new_item(catalog, definition, intent, self.next_instance_id, None)?;

        self.next_instance_id = self
            .next_instance_id
            .checked_add(1)
            .ok_or(RestaurantAuthorityError::InstanceIdExhausted)?;
        self.items.insert(placed.instance_id, placed);
        self.stack_order.push(placed.instance_id);
        Ok(placed)
    }

    pub fn transform(
        &mut self,
        catalog: &PlacementCatalog,
        instance_id: u64,
        tile: TilePoint,
        rotation: u8,
    ) -> Result<PlacedItem, RestaurantAuthorityError> {
        let original = *self
            .items
            .get(&instance_id)
            .ok_or(RestaurantAuthorityError::UnknownInstance { instance_id })?;

        let definition =
            *catalog
                .get(original.item_id)
                .ok_or(RestaurantAuthorityError::UnknownItem {
                    item_id: original.item_id,
                })?;
        let intent = PlacementIntent {
            item_id: original.item_id,
            tile,
            rotation,
        };

        // WorldRestaurant.isValid keeps the edited item in itemMap and, when it
        // is currently the top entry, explicitly looks through itself. Preserve
        // that quirk instead of removing self before validation.
        let updated =
            self.validate_new_item(catalog, definition, intent, instance_id, Some(instance_id))?;

        self.items.insert(instance_id, updated);
        self.stack_order.retain(|value| *value != instance_id);
        self.stack_order.push(instance_id);
        Ok(updated)
    }

    pub fn remove(&mut self, instance_id: u64) -> Result<PlacedItem, RestaurantAuthorityError> {
        let removed = self
            .items
            .remove(&instance_id)
            .ok_or(RestaurantAuthorityError::UnknownInstance { instance_id })?;
        self.stack_order.retain(|value| *value != instance_id);
        Ok(removed)
    }

    pub fn snapshot(&self) -> RestaurantSnapshot {
        RestaurantSnapshot {
            room: self.room,
            next_instance_id: self.next_instance_id,
            items: self
                .stack_order
                .iter()
                .filter_map(|instance_id| self.items.get(instance_id).copied())
                .collect(),
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
            stack_order: Vec::new(),
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
                state.validate_new_item(catalog, definition, intent, stored.instance_id, None)?;

            if validated != stored {
                return Err(RestaurantAuthorityError::SnapshotPlacementMismatch {
                    instance_id: stored.instance_id,
                });
            }

            max_instance_id = max_instance_id.max(stored.instance_id);
            state.items.insert(stored.instance_id, validated);
            state.stack_order.push(stored.instance_id);
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
        self_instance_id: Option<u64>,
    ) -> Result<PlacedItem, RestaurantAuthorityError> {
        // Floor tiles use their own authority/state. Editable wall structures
        // and wallpaper remain fail-closed. Wall decorations are the first
        // recovered wall-domain slice and are normalized against the immutable
        // default wallMap rather than trusting client rotation.
        if definition.flags.floor_tile_item
            || definition.flags.wall_item
            || definition.flags.wallpaper_item
        {
            return Err(RestaurantAuthorityError::UnsupportedPlacementDomain {
                item_id: definition.item_id,
            });
        }

        if definition.flags.wall_decoration_item {
            if definition.footprint
                != (Footprint {
                    size_x: 1,
                    size_y: 1,
                })
            {
                return Err(
                    RestaurantAuthorityError::UnsupportedWallAttachmentFootprint {
                        item_id: definition.item_id,
                    },
                );
            }

            let rotation = default_wall_attachment_rotation(intent.tile, self.room).ok_or(
                RestaurantAuthorityError::NoWallAttachmentTarget {
                    item_id: definition.item_id,
                    tile: intent.tile,
                },
            )?;
            if rotation >= definition.rotation_count {
                return Err(RestaurantAuthorityError::InvalidDefinition {
                    item_id: definition.item_id,
                });
            }

            for existing_id in &self.stack_order {
                if Some(*existing_id) == self_instance_id {
                    continue;
                }
                let existing = self.items.get(existing_id).ok_or(
                    RestaurantAuthorityError::CorruptStackOrder {
                        instance_id: *existing_id,
                    },
                )?;
                if existing.room_index == ROOM_INDEX_MAIN && existing.tile == intent.tile {
                    return Err(RestaurantAuthorityError::Collision {
                        item_id: definition.item_id,
                        with_instance_id: existing.instance_id,
                    });
                }
            }

            return Ok(PlacedItem {
                instance_id,
                item_id: intent.item_id,
                tile: intent.tile,
                rotation,
                room_index: ROOM_INDEX_MAIN,
            });
        }

        if intent.rotation >= definition.rotation_count {
            return Err(RestaurantAuthorityError::InvalidRotation {
                rotation: intent.rotation,
            });
        }

        let occupied_cells = catalog
            .occupied_cells(definition.item_id, intent.rotation)
            .ok_or(RestaurantAuthorityError::InvalidDefinition {
                item_id: definition.item_id,
            })?;
        let unit_shape = PlacementShape {
            footprint: Footprint {
                size_x: 1,
                size_y: 1,
            },
            flags: definition.flags,
        };

        let room_index = match validate_structural_placement(unit_shape, intent.tile, self.room) {
            StructuralPlacement::Valid { room_index } => room_index,
            reason => {
                return Err(RestaurantAuthorityError::StructuralPlacement {
                    item_id: definition.item_id,
                    reason,
                });
            }
        };

        // RoomItem composite geometry is recursive. Validate every exact
        // occupied cell (main item + rotated subitem offsets) independently.
        // Non-composite catalog entries fall back to the historical rectangular
        // footprint cells generated by PlacementCatalog::occupied_cells().
        for offset in &occupied_cells {
            let tile = TilePoint {
                x: intent.tile.x.checked_add(offset.x).ok_or(
                    RestaurantAuthorityError::StructuralPlacement {
                        item_id: definition.item_id,
                        reason: StructuralPlacement::OutOfBounds,
                    },
                )?,
                y: intent.tile.y.checked_add(offset.y).ok_or(
                    RestaurantAuthorityError::StructuralPlacement {
                        item_id: definition.item_id,
                        reason: StructuralPlacement::OutOfBounds,
                    },
                )?,
            };

            if let reason @ (StructuralPlacement::OutOfBounds
            | StructuralPlacement::WrongArea
            | StructuralPlacement::FloorBorder) =
                validate_structural_placement(unit_shape, tile, self.room)
            {
                return Err(RestaurantAuthorityError::StructuralPlacement {
                    item_id: definition.item_id,
                    reason,
                });
            }

            let mut stack = Vec::new();
            for existing_id in &self.stack_order {
                let existing = self.items.get(existing_id).ok_or(
                    RestaurantAuthorityError::CorruptStackOrder {
                        instance_id: *existing_id,
                    },
                )?;
                if existing.room_index != room_index {
                    continue;
                }

                let existing_definition = *catalog.get(existing.item_id).ok_or(
                    RestaurantAuthorityError::UnknownItem {
                        item_id: existing.item_id,
                    },
                )?;
                let existing_cells = catalog
                    .occupied_cells(existing.item_id, existing.rotation)
                    .ok_or(RestaurantAuthorityError::InvalidDefinition {
                        item_id: existing.item_id,
                    })?;

                if existing_cells.iter().any(|existing_offset| {
                    existing.tile.x + existing_offset.x == tile.x
                        && existing.tile.y + existing_offset.y == tile.y
                }) {
                    stack.push(HistoricalTileStackEntry {
                        instance_id: existing.instance_id,
                        surface: existing_definition.flags.surface,
                    });
                }
            }

            match validate_historical_tile_stack(
                definition.flags.stackable,
                &stack,
                self_instance_id,
            ) {
                HistoricalTileStackValidation::Valid => {}
                HistoricalTileStackValidation::BlockedTop {
                    instance_id: blocking_instance_id,
                } => {
                    return Err(RestaurantAuthorityError::Collision {
                        item_id: definition.item_id,
                        with_instance_id: blocking_instance_id,
                    });
                }
                HistoricalTileStackValidation::StackLimit => {
                    return Err(RestaurantAuthorityError::StackLimit {
                        item_id: definition.item_id,
                    });
                }
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
    UnknownInstance {
        instance_id: u64,
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
    UnsupportedWallAttachmentFootprint {
        item_id: u32,
    },
    NoWallAttachmentTarget {
        item_id: u32,
        tile: TilePoint,
    },
    NotFloorTile {
        item_id: u32,
    },
    NotWallpaper {
        item_id: u32,
    },
    UnsupportedWallpaperFootprint {
        item_id: u32,
    },
    NoWallpaperTarget {
        item_id: u32,
        tile: TilePoint,
    },
    UnsupportedFloorTileFootprint {
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
    StackLimit {
        item_id: u32,
    },
    CorruptStackOrder {
        instance_id: u64,
    },
    InstanceIdExhausted,
    InvalidSnapshotInstanceId {
        instance_id: u64,
    },
    SnapshotPlacementMismatch {
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

    fn wall_attachment_catalog() -> PlacementCatalog {
        PlacementCatalog::new([ItemPlacementDefinition {
            item_id: 60,
            footprint: Footprint {
                size_x: 1,
                size_y: 1,
            },
            rotation_count: 2,
            flags: PlacementFlags {
                wall_decoration_item: true,
                ..PlacementFlags::default()
            },
        }])
        .unwrap()
    }

    fn stack_catalog() -> PlacementCatalog {
        PlacementCatalog::new([
            ItemPlacementDefinition {
                item_id: 30,
                footprint: Footprint {
                    size_x: 1,
                    size_y: 1,
                },
                rotation_count: 1,
                flags: PlacementFlags {
                    surface: true,
                    ..PlacementFlags::default()
                },
            },
            ItemPlacementDefinition {
                item_id: 40,
                footprint: Footprint {
                    size_x: 1,
                    size_y: 1,
                },
                rotation_count: 1,
                flags: PlacementFlags {
                    stackable: true,
                    ..PlacementFlags::default()
                },
            },
            ItemPlacementDefinition {
                item_id: 50,
                footprint: Footprint {
                    size_x: 1,
                    size_y: 1,
                },
                rotation_count: 1,
                flags: PlacementFlags {
                    surface: true,
                    stackable: true,
                    ..PlacementFlags::default()
                },
            },
        ])
        .unwrap()
    }

    #[test]
    fn floor_tile_authority_derives_room_and_rejects_zero_border() {
        let catalog = PlacementCatalog::new([ItemPlacementDefinition {
            item_id: 3050000,
            footprint: Footprint {
                size_x: 1,
                size_y: 1,
            },
            rotation_count: 1,
            flags: PlacementFlags {
                floor_tile_item: true,
                ..PlacementFlags::default()
            },
        }])
        .unwrap();

        assert_eq!(
            validate_floor_tile_intent(
                &catalog,
                room(),
                FloorTileIntent {
                    item_id: 3050000,
                    tile: TilePoint { x: 2, y: 3 },
                },
            )
            .unwrap(),
            PaintedFloorTile {
                item_id: 3050000,
                tile: TilePoint { x: 2, y: 3 },
                room_index: 0,
            }
        );

        assert!(matches!(
            validate_floor_tile_intent(
                &catalog,
                room(),
                FloorTileIntent {
                    item_id: 3050000,
                    tile: TilePoint { x: 0, y: 3 },
                },
            ),
            Err(RestaurantAuthorityError::StructuralPlacement {
                reason: StructuralPlacement::OutOfBounds,
                ..
            })
        ));
    }

    #[test]
    fn wallpaper_orientation_is_derived_from_default_wall() {
        let wallpaper_catalog = PlacementCatalog::new([ItemPlacementDefinition {
            item_id: 70,
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
        .unwrap();

        assert_eq!(
            validate_wallpaper_intent(
                &wallpaper_catalog,
                room(),
                WallpaperIntent {
                    item_id: 70,
                    wall_tile: TilePoint { x: 0, y: 3 },
                },
            )
            .unwrap(),
            AppliedWallpaper {
                item_id: 70,
                orientation: WallpaperOrientation::Left,
            }
        );
        assert_eq!(
            validate_wallpaper_intent(
                &wallpaper_catalog,
                room(),
                WallpaperIntent {
                    item_id: 70,
                    wall_tile: TilePoint { x: 4, y: 0 },
                },
            )
            .unwrap(),
            AppliedWallpaper {
                item_id: 70,
                orientation: WallpaperOrientation::Top,
            }
        );
        assert!(matches!(
            validate_wallpaper_intent(
                &wallpaper_catalog,
                room(),
                WallpaperIntent {
                    item_id: 70,
                    wall_tile: TilePoint { x: 0, y: 0 },
                },
            ),
            Err(RestaurantAuthorityError::NoWallpaperTarget { .. })
        ));
        assert!(matches!(
            validate_wallpaper_intent(
                &wallpaper_catalog,
                room(),
                WallpaperIntent {
                    item_id: 70,
                    wall_tile: TilePoint { x: 2, y: 2 },
                },
            ),
            Err(RestaurantAuthorityError::NoWallpaperTarget { .. })
        ));
    }

    #[test]
    fn ordinary_item_cannot_enter_floor_tile_authority() {
        assert_eq!(
            validate_floor_tile_intent(
                &catalog(),
                room(),
                FloorTileIntent {
                    item_id: 20,
                    tile: TilePoint { x: 2, y: 2 },
                },
            ),
            Err(RestaurantAuthorityError::NotFloorTile { item_id: 20 })
        );
    }

    #[test]
    fn wall_attachment_rotation_is_derived_from_default_wall_not_client() {
        let catalog = wall_attachment_catalog();
        let mut state = RestaurantState::new(room());

        let top = state
            .place(
                &catalog,
                PlacementIntent {
                    item_id: 60,
                    tile: TilePoint { x: 2, y: 0 },
                    rotation: 0,
                },
            )
            .unwrap();
        assert_eq!(top.rotation, 1);

        let moved = state
            .transform(&catalog, top.instance_id, TilePoint { x: 0, y: 3 }, 15)
            .unwrap();
        assert_eq!(moved.rotation, 0);
        assert_eq!(moved.tile, TilePoint { x: 0, y: 3 });
    }

    #[test]
    fn wall_attachment_rejects_corner_interior_and_double_occupancy() {
        let catalog = wall_attachment_catalog();
        let mut state = RestaurantState::new(room());

        assert!(matches!(
            state.place(
                &catalog,
                PlacementIntent {
                    item_id: 60,
                    tile: TilePoint { x: 0, y: 0 },
                    rotation: 0,
                },
            ),
            Err(RestaurantAuthorityError::NoWallAttachmentTarget { .. })
        ));
        assert!(matches!(
            state.place(
                &catalog,
                PlacementIntent {
                    item_id: 60,
                    tile: TilePoint { x: 2, y: 2 },
                    rotation: 0,
                },
            ),
            Err(RestaurantAuthorityError::NoWallAttachmentTarget { .. })
        ));

        let first = state
            .place(
                &catalog,
                PlacementIntent {
                    item_id: 60,
                    tile: TilePoint { x: 3, y: 0 },
                    rotation: 0,
                },
            )
            .unwrap();
        assert_eq!(first.rotation, 1);
        assert_eq!(
            state.place(
                &catalog,
                PlacementIntent {
                    item_id: 60,
                    tile: TilePoint { x: 3, y: 0 },
                    rotation: 1,
                },
            ),
            Err(RestaurantAuthorityError::Collision {
                item_id: 60,
                with_instance_id: first.instance_id,
            })
        );
    }

    #[test]
    fn trusted_catalog_loader_accepts_generated_contract() {
        let input = concat!(
            "ANEWON_RC_PLACEMENT_CATALOG_V4\n",
            "# baseline=0.9.143a\n",
            "item_id\tsize_x\tsize_y\trotation_count\twall_item\twall_decoration_item\twallpaper_item\toutdoor\tfloor_tile_item\tsurface\tstackable\tdoor_item\tchair_item\ttable_item\tkitchen\tdrink\ttoilet\toccupied_cells\n",
            "10\t2\t1\t4\t0\t0\t0\t0\t0\t1\t0\n",
            "20\t1\t1\t1\t0\t0\t0\t0\t0\t0\t1\n",
        );
        let catalog = PlacementCatalog::from_trusted_tsv(input).unwrap();
        assert_eq!(catalog.get(10).unwrap().footprint.size_x, 2);
        assert_eq!(catalog.get(20).unwrap().footprint.size_y, 1);
    }

    #[test]
    fn trusted_catalog_loader_preserves_composite_cells_per_rotation() {
        let input = concat!(
            "ANEWON_RC_PLACEMENT_CATALOG_V4\n",
            "item_id\tsize_x\tsize_y\trotation_count\twall_item\twall_decoration_item\twallpaper_item\toutdoor\tfloor_tile_item\tsurface\tstackable\tdoor_item\tchair_item\ttable_item\tkitchen\tdrink\ttoilet\toccupied_cells\n",
            "3070000\t2\t1\t4\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0\t1\t0\t0\t0,0+1,0/0,0+0,1/0,0+-1,0/0,0+0,-1\n",
        );
        let catalog = PlacementCatalog::from_trusted_tsv(input).unwrap();
        assert_eq!(
            catalog.occupied_cells(3070000, 2).unwrap(),
            vec![TilePoint { x: 0, y: 0 }, TilePoint { x: -1, y: 0 }]
        );
        assert!(catalog.service_flags(3070000).kitchen);
    }

    #[test]
    fn trusted_catalog_loader_rejects_duplicate_ids() {
        let input = concat!(
            "ANEWON_RC_PLACEMENT_CATALOG_V4\n",
            "item_id\tsize_x\tsize_y\trotation_count\twall_item\twall_decoration_item\twallpaper_item\toutdoor\tfloor_tile_item\tsurface\tstackable\tdoor_item\tchair_item\ttable_item\tkitchen\tdrink\ttoilet\toccupied_cells\n",
            "10\t2\t1\t4\t0\t0\t0\t0\t0\t1\t0\n",
            "10\t1\t1\t4\t0\t0\t0\t0\t0\t0\t1\n",
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
    fn composite_negative_offsets_are_validated_without_anchor_rebasing() {
        let input = concat!(
            "ANEWON_RC_PLACEMENT_CATALOG_V4\n",
            "item_id\tsize_x\tsize_y\trotation_count\twall_item\twall_decoration_item\twallpaper_item\toutdoor\tfloor_tile_item\tsurface\tstackable\tdoor_item\tchair_item\ttable_item\tkitchen\tdrink\ttoilet\toccupied_cells\n",
            "3070000\t2\t1\t4\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0\t1\t0\t0\t0,0+1,0/0,0+0,1/0,0+-1,0/0,0+0,-1\n",
        );
        let catalog = PlacementCatalog::from_trusted_tsv(input).unwrap();
        let mut state = RestaurantState::new(RoomDimensions {
            inside_x: 10,
            inside_y: 10,
            outside_x: 8,
            outside_y: 4,
        });

        let placed = state
            .place(
                &catalog,
                PlacementIntent {
                    item_id: 3070000,
                    tile: TilePoint { x: 3, y: 3 },
                    rotation: 2,
                },
            )
            .unwrap();
        assert_eq!(placed.tile, TilePoint { x: 3, y: 3 });
        assert_eq!(placed.rotation, 2);

        // Rotation 2 owns (3,3) plus the historical sub1 at (2,3).
        assert_eq!(
            state.place(
                &catalog,
                PlacementIntent {
                    item_id: 3070000,
                    tile: TilePoint { x: 2, y: 3 },
                    rotation: 0,
                },
            ),
            Err(RestaurantAuthorityError::Collision {
                item_id: 3070000,
                with_instance_id: placed.instance_id,
            })
        );

        // The zero border remains reserved for the rotated subitem too.
        assert!(matches!(
            state.place(
                &catalog,
                PlacementIntent {
                    item_id: 3070000,
                    tile: TilePoint { x: 1, y: 3 },
                    rotation: 2,
                },
            ),
            Err(RestaurantAuthorityError::StructuralPlacement {
                reason: StructuralPlacement::OutOfBounds,
                ..
            })
        ));
    }

    #[test]
    fn recovered_stackable_item_can_share_tile_only_with_surface_top() {
        let catalog = stack_catalog();
        let mut state = RestaurantState::new(room());
        let surface = state
            .place(
                &catalog,
                PlacementIntent {
                    item_id: 30,
                    tile: TilePoint { x: 2, y: 2 },
                    rotation: 0,
                },
            )
            .unwrap();

        let stacked = state
            .place(
                &catalog,
                PlacementIntent {
                    item_id: 40,
                    tile: TilePoint { x: 2, y: 2 },
                    rotation: 0,
                },
            )
            .unwrap();
        assert_eq!(state.snapshot().items, vec![surface, stacked]);

        assert_eq!(
            state
                .place(
                    &catalog,
                    PlacementIntent {
                        item_id: 30,
                        tile: TilePoint { x: 2, y: 2 },
                        rotation: 0,
                    },
                )
                .unwrap_err(),
            RestaurantAuthorityError::Collision {
                item_id: 30,
                with_instance_id: stacked.instance_id,
            }
        );

        let mut blocked = RestaurantState::new(room());
        let non_surface = blocked
            .place(
                &catalog,
                PlacementIntent {
                    item_id: 40,
                    tile: TilePoint { x: 3, y: 3 },
                    rotation: 0,
                },
            )
            .unwrap();
        assert_eq!(
            blocked
                .place(
                    &catalog,
                    PlacementIntent {
                        item_id: 40,
                        tile: TilePoint { x: 3, y: 3 },
                        rotation: 0,
                    },
                )
                .unwrap_err(),
            RestaurantAuthorityError::Collision {
                item_id: 40,
                with_instance_id: non_surface.instance_id,
            }
        );
    }

    #[test]
    fn recovered_stack_depth_caps_result_at_five_entries() {
        let catalog = stack_catalog();
        let mut state = RestaurantState::new(room());
        state
            .place(
                &catalog,
                PlacementIntent {
                    item_id: 30,
                    tile: TilePoint { x: 2, y: 2 },
                    rotation: 0,
                },
            )
            .unwrap();

        for _ in 0..4 {
            state
                .place(
                    &catalog,
                    PlacementIntent {
                        item_id: 50,
                        tile: TilePoint { x: 2, y: 2 },
                        rotation: 0,
                    },
                )
                .unwrap();
        }

        assert_eq!(state.snapshot().items.len(), 5);
        assert_eq!(
            state
                .place(
                    &catalog,
                    PlacementIntent {
                        item_id: 50,
                        tile: TilePoint { x: 2, y: 2 },
                        rotation: 0,
                    },
                )
                .unwrap_err(),
            RestaurantAuthorityError::StackLimit { item_id: 50 }
        );
    }

    #[test]
    fn transform_readds_item_at_top_in_historical_item_map_order() {
        let catalog = stack_catalog();
        let mut state = RestaurantState::new(room());
        let surface = state
            .place(
                &catalog,
                PlacementIntent {
                    item_id: 30,
                    tile: TilePoint { x: 2, y: 2 },
                    rotation: 0,
                },
            )
            .unwrap();
        let first = state
            .place(
                &catalog,
                PlacementIntent {
                    item_id: 50,
                    tile: TilePoint { x: 2, y: 2 },
                    rotation: 0,
                },
            )
            .unwrap();
        let previous_top = state
            .place(
                &catalog,
                PlacementIntent {
                    item_id: 50,
                    tile: TilePoint { x: 2, y: 2 },
                    rotation: 0,
                },
            )
            .unwrap();

        // The candidate is stackable and the current top is itself a surface,
        // so historical isValid() permits the edit even while the candidate
        // starts below that top entry. Re-adding it makes it the new top.
        let transformed = state
            .transform(&catalog, first.instance_id, TilePoint { x: 2, y: 2 }, 0)
            .unwrap();
        assert_eq!(transformed, first);
        assert_eq!(state.snapshot().items, vec![surface, previous_top, first]);

        // Once it is top, the recovered self-at-top quirk looks through it to
        // the previous surface and remains valid.
        assert_eq!(
            state
                .transform(&catalog, first.instance_id, TilePoint { x: 2, y: 2 }, 0)
                .unwrap(),
            first
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
    fn transform_preserves_instance_identity_and_sequence() {
        let catalog = catalog();
        let mut state = RestaurantState::new(room());
        let placed = state
            .place(
                &catalog,
                PlacementIntent {
                    item_id: 10,
                    tile: TilePoint { x: 1, y: 1 },
                    rotation: 0,
                },
            )
            .unwrap();

        let updated = state
            .transform(&catalog, placed.instance_id, TilePoint { x: 4, y: 3 }, 1)
            .unwrap();

        assert_eq!(updated.instance_id, placed.instance_id);
        assert_eq!(updated.item_id, placed.item_id);
        assert_eq!(updated.tile, TilePoint { x: 4, y: 3 });
        assert_eq!(updated.rotation, 1);
        assert_eq!(state.snapshot().next_instance_id, 2);
        assert_eq!(state.snapshot().items, vec![updated]);
    }

    #[test]
    fn rejected_transform_restores_original_item() {
        let catalog = catalog();
        let mut state = RestaurantState::new(room());
        let first = state
            .place(
                &catalog,
                PlacementIntent {
                    item_id: 10,
                    tile: TilePoint { x: 1, y: 1 },
                    rotation: 0,
                },
            )
            .unwrap();
        let second = state
            .place(
                &catalog,
                PlacementIntent {
                    item_id: 20,
                    tile: TilePoint { x: 5, y: 5 },
                    rotation: 0,
                },
            )
            .unwrap();

        assert_eq!(
            state
                .transform(&catalog, second.instance_id, TilePoint { x: 2, y: 1 }, 0)
                .unwrap_err(),
            RestaurantAuthorityError::Collision {
                item_id: 20,
                with_instance_id: first.instance_id,
            }
        );

        assert!(state.items().any(|item| *item == second));
        assert_eq!(state.snapshot().next_instance_id, 3);
    }

    #[test]
    fn remove_returns_item_and_releases_instance_from_layout() {
        let catalog = catalog();
        let mut state = RestaurantState::new(room());
        let placed = state
            .place(
                &catalog,
                PlacementIntent {
                    item_id: 20,
                    tile: TilePoint { x: 2, y: 2 },
                    rotation: 0,
                },
            )
            .unwrap();

        assert_eq!(state.remove(placed.instance_id).unwrap(), placed);
        assert!(state.items().next().is_none());
        assert_eq!(state.snapshot().next_instance_id, 2);
        assert_eq!(
            state.remove(placed.instance_id),
            Err(RestaurantAuthorityError::UnknownInstance {
                instance_id: placed.instance_id,
            })
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
    fn tampered_snapshot_placement_is_rejected() {
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
            RestaurantAuthorityError::SnapshotPlacementMismatch { instance_id: 1 }
        );
    }
}
