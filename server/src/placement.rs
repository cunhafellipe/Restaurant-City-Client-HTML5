pub const TILE_WIDTH: i32 = 80;
pub const TILE_HEIGHT: i32 = 40;
pub const TILE_WIDTH_HALF: i32 = 40;
pub const TILE_HEIGHT_HALF: i32 = 20;

pub const ROOM_INDEX_MAIN: u8 = 0;
pub const ROOM_INDEX_OUTSIDE_AREA: u8 = 1;

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
