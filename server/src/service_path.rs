//! Source-grounded actor path planning/timing for the first Restaurant City
//! live-service lifecycle.
//!
//! Historical movement evidence:
//! - WorldRestaurant tiles are 80x40 pixels (40x20 isometric half-tile);
//! - RestaurantActor default movement is X=0.06 / Y=0.03 pixels per ms;
//! - Waitor Y speed is 0.01..0.03 from employee work percentage and X=2*Y;
//! - actors complete a path only when curPath is empty and both axis speeds are zero.
//!
//! Browser animation is presentation only. These helpers let the authoritative
//! server reconstruct the exact tile path and a conservative integer-ms
//! completion deadline without accepting browser-authored path completion.

use crate::placement::TilePoint;
use crate::topology::{
    HistoricalPath, ServiceLayoutSnapshot, historical_path, path_to_customer_chair,
};

pub const HISTORICAL_TILE_WIDTH_PX: i32 = 80;
pub const HISTORICAL_TILE_HEIGHT_PX: i32 = 40;
pub const HISTORICAL_TILE_WIDTH_HALF_PX: i32 = HISTORICAL_TILE_WIDTH_PX / 2;
pub const HISTORICAL_TILE_HEIGHT_HALF_PX: i32 = HISTORICAL_TILE_HEIGHT_PX / 2;

pub const CUSTOMER_MOVE_SPEED_X_PX_PER_MS: f64 = 0.06;
pub const CUSTOMER_MOVE_SPEED_Y_PX_PER_MS: f64 = 0.03;
pub const WAITER_MOVE_SPEED_Y_MIN_PX_PER_MS: f64 = 0.01;
pub const WAITER_MOVE_SPEED_Y_MAX_PX_PER_MS: f64 = 0.03;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ServicePathError {
    InvalidWorkPercent,
    InvalidSpeed,
    ArithmeticOverflow,
}

pub fn canonical_waiter_walk_speed_y(
    work_percent: f64,
) -> Result<f64, ServicePathError> {
    if !work_percent.is_finite() || !(0.0..=100.0).contains(&work_percent) {
        return Err(ServicePathError::InvalidWorkPercent);
    }

    if work_percent >= 80.0 {
        return Ok(WAITER_MOVE_SPEED_Y_MAX_PX_PER_MS);
    }
    if work_percent < 20.0 {
        return Ok(WAITER_MOVE_SPEED_Y_MIN_PX_PER_MS);
    }

    Ok(
        WAITER_MOVE_SPEED_Y_MIN_PX_PER_MS
            + (WAITER_MOVE_SPEED_Y_MAX_PX_PER_MS
                - WAITER_MOVE_SPEED_Y_MIN_PX_PER_MS)
                * (work_percent - 20.0)
                / 60.0,
    )
}

/// Canonical customer chair movement ends on the chair tile itself.
///
/// Customer.walkToChair uses stopNextToDestTile=false. The chair-facing table
/// tile is association/service geometry, not the seated customer position.
pub fn customer_path_to_chair(
    layout: &ServiceLayoutSnapshot,
    start: TilePoint,
    chair_instance_id: u64,
) -> Option<HistoricalPath> {
    let chair = layout
        .chairs
        .iter()
        .find(|chair| chair.instance_id == chair_instance_id)?;
    historical_path(&layout.grid, start, chair.tile, false)
}

/// Canonical cooked-order pickup path.
///
/// WorldRestaurantPlay.getClosestFreeWaitor obtains a path to the occupied
/// kitchen using stopNextToDestTile=true, then
/// moveClosestFreeWaitorToCookedOrder explicitly pops the destination before
/// assigning the path to the waiter.
pub fn waiter_path_to_kitchen_pickup(
    layout: &ServiceLayoutSnapshot,
    start: TilePoint,
    kitchen_instance_id: u64,
) -> Option<HistoricalPath> {
    let kitchen = layout
        .kitchens
        .iter()
        .find(|kitchen| kitchen.instance_id == kitchen_instance_id)?;
    historical_path(&layout.grid, start, kitchen.tile, true)
        .map(HistoricalPath::without_destination)
}

/// Canonical waiter service path.
///
/// getPathToCustomer first targets the chair-facing tile and falls back to the
/// chair tile. Waitor.serveCustomer then pops that occupied destination before
/// moving, so the waiter stops next to the customer/table instead of
/// overlapping it.
pub fn waiter_path_to_customer(
    layout: &ServiceLayoutSnapshot,
    start: TilePoint,
    chair_instance_id: u64,
) -> Option<HistoricalPath> {
    let chair = layout
        .chairs
        .iter()
        .find(|chair| chair.instance_id == chair_instance_id)?;
    path_to_customer_chair(&layout.grid, start, chair.tile, chair.rotation)
        .map(HistoricalPath::without_destination)
}

/// Customer.leave uses moveToTile(entranceTileX, entranceTileY, false), so the
/// authoritative exit path ends on the stored entrance tile.
pub fn customer_path_to_exit(
    layout: &ServiceLayoutSnapshot,
    start: TilePoint,
    entrance: TilePoint,
) -> Option<HistoricalPath> {
    historical_path(&layout.grid, start, entrance, false)
}

pub fn customer_path_duration_ms(
    start: TilePoint,
    path: &HistoricalPath,
) -> Result<u64, ServicePathError> {
    path_duration_ms(
        start,
        path,
        CUSTOMER_MOVE_SPEED_X_PX_PER_MS,
        CUSTOMER_MOVE_SPEED_Y_PX_PER_MS,
    )
}

pub fn waiter_path_duration_ms(
    start: TilePoint,
    path: &HistoricalPath,
    work_percent: f64,
) -> Result<u64, ServicePathError> {
    let speed_y = canonical_waiter_walk_speed_y(work_percent)?;
    path_duration_ms(start, path, speed_y * 2.0, speed_y)
}

/// Convert a tile path into the earliest integer server millisecond at which
/// the historical continuous axis movement can be complete.
///
/// RestaurantActor clamps each axis at its destination and requires both
/// speeds to reach zero. A segment therefore takes the slower axis duration.
/// We ceil each segment so the server can never declare completion before the
/// historical actor could have reached its target.
pub fn path_duration_ms(
    start: TilePoint,
    path: &HistoricalPath,
    speed_x_px_per_ms: f64,
    speed_y_px_per_ms: f64,
) -> Result<u64, ServicePathError> {
    if !speed_x_px_per_ms.is_finite()
        || !speed_y_px_per_ms.is_finite()
        || speed_x_px_per_ms <= 0.0
        || speed_y_px_per_ms <= 0.0
    {
        return Err(ServicePathError::InvalidSpeed);
    }

    let mut total_ms = 0_u64;
    let mut from = start;
    for to in &path.tiles {
        let tile_dx = i64::from(to.x) - i64::from(from.x);
        let tile_dy = i64::from(to.y) - i64::from(from.y);
        let screen_dx = ((tile_dx - tile_dy) * i64::from(HISTORICAL_TILE_WIDTH_HALF_PX))
            .unsigned_abs() as f64;
        let screen_dy = ((tile_dx + tile_dy) * i64::from(HISTORICAL_TILE_HEIGHT_HALF_PX))
            .unsigned_abs() as f64;

        let segment_ms = (screen_dx / speed_x_px_per_ms)
            .max(screen_dy / speed_y_px_per_ms)
            .ceil();
        if !segment_ms.is_finite() || segment_ms < 0.0 || segment_ms > u64::MAX as f64 {
            return Err(ServicePathError::ArithmeticOverflow);
        }
        total_ms = total_ms
            .checked_add(segment_ms as u64)
            .ok_or(ServicePathError::ArithmeticOverflow)?;
        from = *to;
    }
    Ok(total_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::placement::RoomDimensions;
    use crate::topology::{ServiceChair, ServiceKitchen, ServiceTopologyGrid};

    fn layout() -> ServiceLayoutSnapshot {
        ServiceLayoutSnapshot {
            grid: ServiceTopologyGrid::new(RoomDimensions {
                inside_x: 8,
                inside_y: 8,
                outside_x: 0,
                outside_y: 0,
            }),
            chairs: vec![ServiceChair {
                instance_id: 11,
                tile: TilePoint { x: 2, y: 2 },
                rotation: 0,
                toilet: false,
            }],
            tables: vec![],
            kitchens: vec![ServiceKitchen {
                instance_id: 13,
                tile: TilePoint { x: 6, y: 4 },
            }],
            drinks: vec![],
        }
    }

    #[test]
    fn customer_chair_path_ends_on_chair_not_facing_table_tile() {
        let layout = layout();
        let path = customer_path_to_chair(&layout, TilePoint { x: 1, y: 4 }, 11).unwrap();
        assert_eq!(path.tiles.last(), Some(&TilePoint { x: 2, y: 2 }));
        assert_ne!(path.tiles.last(), Some(&TilePoint { x: 3, y: 2 }));
    }

    #[test]
    fn waiter_kitchen_pickup_drops_occupied_kitchen_destination() {
        let layout = layout();
        let path =
            waiter_path_to_kitchen_pickup(&layout, TilePoint { x: 4, y: 4 }, 13).unwrap();
        assert_ne!(path.tiles.last(), Some(&TilePoint { x: 6, y: 4 }));
    }

    #[test]
    fn waiter_customer_path_drops_the_customer_target_destination() {
        let layout = layout();
        let full = path_to_customer_chair(
            &layout.grid,
            TilePoint { x: 4, y: 4 },
            TilePoint { x: 2, y: 2 },
            0,
        )
        .unwrap();
        let expected_target = *full.tiles.last().unwrap();

        let path = waiter_path_to_customer(&layout, TilePoint { x: 4, y: 4 }, 11).unwrap();
        assert_ne!(path.tiles.last(), Some(&expected_target));
        assert_eq!(path.step_count() + 1, full.step_count());
    }

    #[test]
    fn customer_segment_timing_matches_80x40_isometric_geometry() {
        let cardinal = HistoricalPath {
            tiles: vec![TilePoint { x: 2, y: 1 }],
            movement_score: 10,
        };
        let diagonal = HistoricalPath {
            tiles: vec![TilePoint { x: 2, y: 2 }],
            movement_score: 14,
        };

        assert_eq!(
            customer_path_duration_ms(TilePoint { x: 1, y: 1 }, &cardinal).unwrap(),
            667
        );
        assert_eq!(
            customer_path_duration_ms(TilePoint { x: 1, y: 1 }, &diagonal).unwrap(),
            1334
        );
    }

    #[test]
    fn waiter_walk_speed_uses_historical_work_percentage_interpolation() {
        assert!((canonical_waiter_walk_speed_y(100.0).unwrap() - 0.03).abs() < f64::EPSILON);
        assert!((canonical_waiter_walk_speed_y(80.0).unwrap() - 0.03).abs() < f64::EPSILON);
        assert!((canonical_waiter_walk_speed_y(50.0).unwrap() - 0.02).abs() < f64::EPSILON);
        assert!((canonical_waiter_walk_speed_y(19.0).unwrap() - 0.01).abs() < f64::EPSILON);
        assert_eq!(
            canonical_waiter_walk_speed_y(-1.0),
            Err(ServicePathError::InvalidWorkPercent)
        );
    }

    #[test]
    fn waiter_path_timing_slows_with_work_percentage() {
        let path = HistoricalPath {
            tiles: vec![TilePoint { x: 2, y: 1 }],
            movement_score: 10,
        };
        assert_eq!(
            waiter_path_duration_ms(TilePoint { x: 1, y: 1 }, &path, 80.0).unwrap(),
            667
        );
        assert_eq!(
            waiter_path_duration_ms(TilePoint { x: 1, y: 1 }, &path, 50.0).unwrap(),
            1000
        );
        assert_eq!(
            waiter_path_duration_ms(TilePoint { x: 1, y: 1 }, &path, 0.0).unwrap(),
            2000
        );
    }

    #[test]
    fn path_duration_sums_sequential_historical_segments() {
        let path = HistoricalPath {
            tiles: vec![
                TilePoint { x: 2, y: 1 },
                TilePoint { x: 3, y: 2 },
            ],
            movement_score: 24,
        };
        assert_eq!(
            customer_path_duration_ms(TilePoint { x: 1, y: 1 }, &path).unwrap(),
            2001
        );
    }
}
