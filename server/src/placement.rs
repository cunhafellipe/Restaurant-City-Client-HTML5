pub const TILE_WIDTH: i32 = 80;
pub const TILE_HEIGHT: i32 = 40;
pub const TILE_WIDTH_HALF: i32 = 40;
pub const TILE_HEIGHT_HALF: i32 = 20;

pub const ROOM_INDEX_MAIN: u8 = 0;
pub const ROOM_INDEX_OUTSIDE_AREA: u8 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DefaultWallKind {
    Corner,
    Segment,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DefaultWallSegment {
    pub kind: DefaultWallKind,
    /// Historical RoomItem rotation index copied by WorldRestaurantEditor
    /// when a wall decoration is dragged over this wall.
    pub rotation: u8,
}

pub fn default_wall_at(tile: TilePoint, room: RoomDimensions) -> Option<DefaultWallSegment> {
    if tile.x < 0 || tile.y < 0 {
        return None;
    }
    let x = u32::try_from(tile.x).ok()?;
    let y = u32::try_from(tile.y).ok()?;

    if x == 0 && y == 0 {
        return Some(DefaultWallSegment {
            kind: DefaultWallKind::Corner,
            rotation: 0,
        });
    }
    if y == 0 && x > 0 && x < room.inside_x {
        return Some(DefaultWallSegment {
            kind: DefaultWallKind::Segment,
            rotation: 1,
        });
    }
    if x == 0 && y > 0 && y < room.inside_y {
        return Some(DefaultWallSegment {
            kind: DefaultWallKind::Segment,
            rotation: 0,
        });
    }
    None
}

pub fn default_wall_attachment_rotation(tile: TilePoint, room: RoomDimensions) -> Option<u8> {
    let wall = default_wall_at(tile, room)?;
    (wall.kind == DefaultWallKind::Segment).then_some(wall.rotation)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TilePoint {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ScreenPoint {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Footprint {
    pub size_x: u32,
    pub size_y: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RoomDimensions {
    pub inside_x: u32,
    pub inside_y: u32,
    pub outside_x: u32,
    pub outside_y: u32,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PlacementFlags {
    pub wall_item: bool,
    pub wall_decoration_item: bool,
    pub wallpaper_item: bool,
    pub outdoor: bool,
    pub floor_tile_item: bool,
    pub surface: bool,
    pub stackable: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PlacementShape {
    pub footprint: Footprint,
    pub flags: PlacementFlags,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StructuralPlacement {
    Valid { room_index: u8 },
    OutOfBounds,
    WrongArea,
    FloorBorder,
}

pub fn project_tile(tile: TilePoint) -> ScreenPoint {
    ScreenPoint {
        x: (tile.x - tile.y) * TILE_WIDTH_HALF,
        y: (tile.x + tile.y) * TILE_HEIGHT_HALF,
    }
}

pub const fn decode_owned_item_data(data: u8) -> (u8, u8) {
    (data & 0x0f, (data & 0xf0) >> 4)
}

pub const fn encode_owned_item_data(rotation: u8, usage_count: u8) -> Option<u8> {
    if rotation > 0x0f || usage_count > 0x0f {
        return None;
    }
    Some((usage_count << 4) | rotation)
}

pub const fn rotate_footprint(footprint: Footprint, quarter_turns: i32) -> Footprint {
    if quarter_turns.rem_euclid(2) == 0 {
        footprint
    } else {
        Footprint {
            size_x: footprint.size_y,
            size_y: footprint.size_x,
        }
    }
}

pub fn is_item_out_of_bounds(shape: PlacementShape, tile: TilePoint, room: RoomDimensions) -> bool {
    let wall_domain =
        shape.flags.wall_item || shape.flags.wall_decoration_item || shape.flags.wallpaper_item;

    if wall_domain {
        return !(tile.x >= 0
            && tile.y >= 0
            && u32::try_from(tile.x).is_ok_and(|x| x < room.inside_x)
            && u32::try_from(tile.y).is_ok_and(|y| y < room.inside_y));
    }

    if tile.x < 1 || tile.y < 1 {
        return true;
    }

    let Ok(tile_x) = u32::try_from(tile.x) else {
        return true;
    };
    let Ok(tile_y) = u32::try_from(tile.y) else {
        return true;
    };

    let Some(max_x) = tile_x.checked_add(shape.footprint.size_x.saturating_sub(1)) else {
        return true;
    };
    let Some(max_y) = tile_y.checked_add(shape.footprint.size_y.saturating_sub(1)) else {
        return true;
    };

    if max_y >= room.inside_y {
        max_x >= room.outside_x || max_y >= room.inside_y.saturating_add(room.outside_y)
    } else {
        max_x >= room.inside_x || max_y >= room.inside_y
    }
}

pub fn is_tile_in_outside_area(tile: TilePoint, room: RoomDimensions) -> bool {
    tile.y >= 0
        && u32::try_from(tile.y).is_ok_and(|y| y >= room.inside_y)
        && tile.x >= 0
        && u32::try_from(tile.x).is_ok_and(|x| x < room.outside_x)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HistoricalTileStackEntry {
    pub instance_id: u64,
    pub surface: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HistoricalTileStackValidation {
    Valid,
    BlockedTop { instance_id: u64 },
    StackLimit,
}

/// Exact ordinary-tile stack rule recovered from WorldRestaurant.isValid().
///
/// itemMap ordering is bottom -> top. A new candidate may share an occupied
/// tile only when it is stackable and the current top item is a surface.
/// Existing occupancy is capped so insertion never exceeds five entries.
///
/// When the item being validated is already the top entry, the historical
/// client looks through itself and raises the length threshold by one.
pub fn validate_historical_tile_stack(
    candidate_stackable: bool,
    stack: &[HistoricalTileStackEntry],
    self_instance_id: Option<u64>,
) -> HistoricalTileStackValidation {
    let mut top_index = stack.len().checked_sub(1);
    let mut length_threshold = 5_usize;

    if let (Some(index), Some(self_id)) = (top_index, self_instance_id)
        && stack[index].instance_id == self_id
    {
        top_index = index.checked_sub(1);
        length_threshold += 1;
    }

    if let Some(index) = top_index {
        let top = stack[index];
        if !candidate_stackable || !top.surface {
            return HistoricalTileStackValidation::BlockedTop {
                instance_id: top.instance_id,
            };
        }
    }

    if stack.len() > length_threshold - 1 {
        return HistoricalTileStackValidation::StackLimit;
    }

    HistoricalTileStackValidation::Valid
}

pub fn validate_structural_placement(
    shape: PlacementShape,
    tile: TilePoint,
    room: RoomDimensions,
) -> StructuralPlacement {
    if is_item_out_of_bounds(shape, tile, room) {
        return StructuralPlacement::OutOfBounds;
    }

    if shape.flags.floor_tile_item && (tile.x == 0 || tile.y == 0) {
        return StructuralPlacement::FloorBorder;
    }

    let outside = is_tile_in_outside_area(tile, room);
    if shape.flags.outdoor && !outside {
        return StructuralPlacement::WrongArea;
    }

    StructuralPlacement::Valid {
        room_index: if outside {
            ROOM_INDEX_OUTSIDE_AREA
        } else {
            ROOM_INDEX_MAIN
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room() -> RoomDimensions {
        RoomDimensions {
            inside_x: 10,
            inside_y: 10,
            outside_x: 8,
            outside_y: 4,
        }
    }

    #[test]
    fn default_walls_match_recovered_add_default_walls() {
        let room = room();
        assert_eq!(
            default_wall_at(TilePoint { x: 0, y: 0 }, room),
            Some(DefaultWallSegment {
                kind: DefaultWallKind::Corner,
                rotation: 0,
            })
        );
        assert_eq!(
            default_wall_attachment_rotation(TilePoint { x: 1, y: 0 }, room),
            Some(1)
        );
        assert_eq!(
            default_wall_attachment_rotation(TilePoint { x: 9, y: 0 }, room),
            Some(1)
        );
        assert_eq!(
            default_wall_attachment_rotation(TilePoint { x: 0, y: 1 }, room),
            Some(0)
        );
        assert_eq!(
            default_wall_attachment_rotation(TilePoint { x: 0, y: 9 }, room),
            Some(0)
        );
        assert_eq!(
            default_wall_attachment_rotation(TilePoint { x: 0, y: 0 }, room),
            None
        );
        assert_eq!(
            default_wall_attachment_rotation(TilePoint { x: 2, y: 2 }, room),
            None
        );
        assert_eq!(
            default_wall_attachment_rotation(TilePoint { x: 10, y: 0 }, room),
            None
        );
        assert_eq!(
            default_wall_attachment_rotation(TilePoint { x: 0, y: 10 }, room),
            None
        );
    }

    #[test]
    fn projection_matches_recovered_client() {
        assert_eq!(
            project_tile(TilePoint { x: 3, y: 1 }),
            ScreenPoint { x: 80, y: 80 }
        );
    }

    #[test]
    fn owned_item_data_matches_recovered_nibbles() {
        assert_eq!(decode_owned_item_data(0xa3), (3, 10));
        assert_eq!(encode_owned_item_data(3, 10), Some(0xa3));
    }

    #[test]
    fn odd_rotations_swap_footprint_axes() {
        let source = Footprint {
            size_x: 3,
            size_y: 1,
        };
        assert_eq!(
            rotate_footprint(source, 1),
            Footprint {
                size_x: 1,
                size_y: 3
            }
        );
        assert_eq!(rotate_footprint(source, 2), source);
    }

    #[test]
    fn recovered_stackable_on_surface_rule_is_exact() {
        let surface = [HistoricalTileStackEntry {
            instance_id: 1,
            surface: true,
        }];
        assert_eq!(
            validate_historical_tile_stack(true, &surface, None),
            HistoricalTileStackValidation::Valid
        );
        assert_eq!(
            validate_historical_tile_stack(false, &surface, None),
            HistoricalTileStackValidation::BlockedTop { instance_id: 1 }
        );

        let not_surface = [HistoricalTileStackEntry {
            instance_id: 1,
            surface: false,
        }];
        assert_eq!(
            validate_historical_tile_stack(true, &not_surface, None),
            HistoricalTileStackValidation::BlockedTop { instance_id: 1 }
        );
    }

    #[test]
    fn recovered_item_map_limit_is_five_entries_per_tile() {
        let four = [
            HistoricalTileStackEntry {
                instance_id: 1,
                surface: true,
            },
            HistoricalTileStackEntry {
                instance_id: 2,
                surface: true,
            },
            HistoricalTileStackEntry {
                instance_id: 3,
                surface: true,
            },
            HistoricalTileStackEntry {
                instance_id: 4,
                surface: true,
            },
        ];
        assert_eq!(
            validate_historical_tile_stack(true, &four, None),
            HistoricalTileStackValidation::Valid
        );

        let five = [
            four[0],
            four[1],
            four[2],
            four[3],
            HistoricalTileStackEntry {
                instance_id: 5,
                surface: true,
            },
        ];
        assert_eq!(
            validate_historical_tile_stack(true, &five, None),
            HistoricalTileStackValidation::StackLimit
        );
    }

    #[test]
    fn recovered_self_at_top_looks_through_itself() {
        let stack = [
            HistoricalTileStackEntry {
                instance_id: 1,
                surface: true,
            },
            HistoricalTileStackEntry {
                instance_id: 2,
                surface: true,
            },
            HistoricalTileStackEntry {
                instance_id: 3,
                surface: true,
            },
            HistoricalTileStackEntry {
                instance_id: 4,
                surface: true,
            },
            HistoricalTileStackEntry {
                instance_id: 5,
                surface: false,
            },
        ];

        assert_eq!(
            validate_historical_tile_stack(true, &stack, Some(5)),
            HistoricalTileStackValidation::Valid
        );
        assert_eq!(
            validate_historical_tile_stack(true, &stack, Some(4)),
            HistoricalTileStackValidation::BlockedTop { instance_id: 5 }
        );
    }

    #[test]
    fn ordinary_items_reserve_zero_border() {
        let shape = PlacementShape {
            footprint: Footprint {
                size_x: 1,
                size_y: 1,
            },
            flags: PlacementFlags::default(),
        };
        assert!(is_item_out_of_bounds(
            shape,
            TilePoint { x: 0, y: 5 },
            room()
        ));
        assert!(!is_item_out_of_bounds(
            shape,
            TilePoint { x: 1, y: 1 },
            room()
        ));
    }

    #[test]
    fn outdoor_item_routes_to_outside_room() {
        let shape = PlacementShape {
            footprint: Footprint {
                size_x: 1,
                size_y: 1,
            },
            flags: PlacementFlags {
                outdoor: true,
                ..PlacementFlags::default()
            },
        };
        assert_eq!(
            validate_structural_placement(shape, TilePoint { x: 2, y: 10 }, room()),
            StructuralPlacement::Valid {
                room_index: ROOM_INDEX_OUTSIDE_AREA
            }
        );
        assert_eq!(
            validate_structural_placement(shape, TilePoint { x: 2, y: 2 }, room()),
            StructuralPlacement::WrongArea
        );
    }
}
