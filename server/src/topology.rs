use crate::placement::{RoomDimensions, TilePoint};

pub const MAX_NUM_TILES_X: i32 = 20;
pub const MAX_NUM_TILES_Y: i32 = 40;
const STRAIGHT_SCORE: i32 = 10;
const DIAGONAL_SCORE: i32 = 14;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TopologyCell {
    pub wall: bool,
    pub item_count: u8,
    pub has_door: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceTopologyGrid {
    room: RoomDimensions,
    cells: Vec<TopologyCell>,
}

impl ServiceTopologyGrid {
    pub fn new(room: RoomDimensions) -> Self {
        Self {
            room,
            cells: vec![TopologyCell::default(); (MAX_NUM_TILES_X * MAX_NUM_TILES_Y) as usize],
        }
    }

    pub fn room(&self) -> RoomDimensions {
        self.room
    }

    pub fn cell(&self, tile: TilePoint) -> Option<TopologyCell> {
        self.index(tile).map(|index| self.cells[index])
    }

    pub fn set_cell(&mut self, tile: TilePoint, cell: TopologyCell) -> Result<(), TopologyError> {
        let Some(index) = self.index(tile) else {
            return Err(TopologyError::GridCoordinateOutOfRange);
        };
        self.cells[index] = cell;
        Ok(())
    }

    /// Exact WorldRestaurant.isTileOutOfBound room-shape rule.
    pub fn is_tile_out_of_bound(&self, tile: TilePoint) -> bool {
        if tile.y >= self.room.inside_y as i32 {
            tile.x < 0
                || tile.x >= self.room.outside_x as i32
                || tile.y >= (self.room.inside_y + self.room.outside_y) as i32
        } else {
            tile.x < 0
                || tile.x >= self.room.inside_x as i32
                || tile.y < 0
                || tile.y >= self.room.inside_y as i32
        }
    }

    /// Exact WorldRestaurant.isWalkable occupancy semantics:
    /// empty non-wall tiles are walkable; a wall tile is walkable only when a
    /// door item occupies it.
    pub fn is_walkable(&self, tile: TilePoint) -> bool {
        if self.is_tile_out_of_bound(tile) {
            return false;
        }
        let Some(cell) = self.cell(tile) else {
            return false;
        };
        if !cell.wall {
            return cell.item_count == 0;
        }
        cell.has_door
    }

    /// Exact WorldRestaurant.isWalkableFrom diagonal corner rule used by the
    /// historical PathFinder.
    pub fn is_walkable_from(
        &self,
        from: TilePoint,
        to: TilePoint,
        force_destination: bool,
        allow_diagonal_corner_cut: bool,
    ) -> bool {
        if !force_destination && !self.is_walkable(to) {
            return false;
        }

        let diagonal = to.x - from.x != 0 && to.y - from.y != 0;
        if diagonal && !allow_diagonal_corner_cut {
            let horizontal = TilePoint { x: to.x, y: from.y };
            let vertical = TilePoint { x: from.x, y: to.y };
            if !self.is_walkable(horizontal) || !self.is_walkable(vertical) {
                return false;
            }
        }
        true
    }

    fn index(&self, tile: TilePoint) -> Option<usize> {
        if tile.x < 0 || tile.y < 0 || tile.x >= MAX_NUM_TILES_X || tile.y >= MAX_NUM_TILES_Y {
            return None;
        }
        Some((tile.y * MAX_NUM_TILES_X + tile.x) as usize)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PathNode {
    tile: TilePoint,
    parent: Option<usize>,
    g: i32,
    f: i32,
    open: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoricalPath {
    pub tiles: Vec<TilePoint>,
    pub movement_score: i32,
}

impl HistoricalPath {
    pub fn step_count(&self) -> usize {
        self.tiles.len()
    }

    /// Callers such as waiter kitchen pickup historically pop the occupied
    /// destination after using stopNextToDestTile=true.
    pub fn without_destination(mut self) -> Self {
        self.tiles.pop();
        self
    }
}

pub fn historical_path(
    grid: &ServiceTopologyGrid,
    start: TilePoint,
    destination: TilePoint,
    stop_next_to_destination: bool,
) -> Option<HistoricalPath> {
    if grid.index(start).is_none() || grid.index(destination).is_none() {
        return None;
    }

    let mut nodes: Vec<PathNode> = Vec::new();
    let mut node_index = vec![None; (MAX_NUM_TILES_X * MAX_NUM_TILES_Y) as usize];
    let mut open_list: Vec<usize> = Vec::new();

    let start_index = nodes.len();
    nodes.push(PathNode {
        tile: start,
        parent: None,
        g: 0,
        f: 0,
        open: true,
    });
    node_index[grid.index(start)?] = Some(start_index);
    open_list.push(start_index);

    while let Some(&current_index) = open_list.first() {
        let current = nodes[current_index];
        if current.tile == destination {
            let mut tiles = Vec::new();
            let mut cursor = current_index;
            while let Some(parent) = nodes[cursor].parent {
                tiles.push(nodes[cursor].tile);
                cursor = parent;
            }
            tiles.reverse();
            return Some(HistoricalPath {
                tiles,
                movement_score: current.g,
            });
        }

        nodes[current_index].open = false;
        open_list.remove(0);

        let x_min = current.tile.x - 1;
        let x_max = current.tile.x + 1;
        let y_min = current.tile.y - 1;
        let y_max = current.tile.y + 1;

        for x in x_min..=x_max {
            if !(0..MAX_NUM_TILES_X).contains(&x) {
                continue;
            }
            for y in y_min..=y_max {
                if !(0..MAX_NUM_TILES_Y).contains(&y)
                    || (x == current.tile.x && y == current.tile.y)
                {
                    continue;
                }

                let next = TilePoint { x, y };
                let next_grid_index = grid.index(next)?;
                let valid = if next == destination && stop_next_to_destination {
                    true
                } else {
                    grid.is_walkable_from(current.tile, next, next == destination, false)
                };
                if !valid {
                    continue;
                }

                let diagonal = x != current.tile.x && y != current.tile.y;
                let new_g = current.g
                    + if diagonal {
                        DIAGONAL_SCORE
                    } else {
                        STRAIGHT_SCORE
                    };

                match node_index[next_grid_index] {
                    None => {
                        let heuristic = manhattan_heuristic(next, destination);
                        let index = nodes.len();
                        nodes.push(PathNode {
                            tile: next,
                            parent: Some(current_index),
                            g: new_g,
                            f: new_g + heuristic,
                            open: true,
                        });
                        node_index[next_grid_index] = Some(index);

                        // AS3 inserts before the first equal fScore entry.
                        let insert_at = open_list
                            .iter()
                            .position(|candidate| nodes[index].f <= nodes[*candidate].f)
                            .unwrap_or(open_list.len());
                        open_list.insert(insert_at, index);
                    }
                    Some(index) if nodes[index].open && new_g < nodes[index].g => {
                        nodes[index].g = new_g;
                        nodes[index].f = new_g + manhattan_heuristic(next, destination);
                        nodes[index].parent = Some(current_index);

                        if let Some(position) =
                            open_list.iter().position(|candidate| *candidate == index)
                        {
                            open_list.remove(position);
                        }
                        let insert_at = open_list
                            .iter()
                            .position(|candidate| nodes[index].f <= nodes[*candidate].f)
                            .unwrap_or(open_list.len());
                        open_list.insert(insert_at, index);
                    }
                    _ => {}
                }
            }
        }
    }

    None
}

fn manhattan_heuristic(tile: TilePoint, destination: TilePoint) -> i32 {
    ((destination.x - tile.x).abs() + (destination.y - tile.y).abs()) * STRAIGHT_SCORE
}

pub fn facing_tile(tile: TilePoint, rotation: u8) -> TilePoint {
    match rotation {
        0 => TilePoint {
            x: tile.x + 1,
            y: tile.y,
        },
        1 => TilePoint {
            x: tile.x,
            y: tile.y + 1,
        },
        2 => TilePoint {
            x: tile.x - 1,
            y: tile.y,
        },
        3 => TilePoint {
            x: tile.x,
            y: tile.y - 1,
        },
        _ => tile,
    }
}

pub fn path_to_customer_chair(
    grid: &ServiceTopologyGrid,
    start: TilePoint,
    chair_tile: TilePoint,
    chair_rotation: u8,
) -> Option<HistoricalPath> {
    let facing = facing_tile(chair_tile, chair_rotation);
    historical_path(grid, start, facing, true)
        .or_else(|| historical_path(grid, start, chair_tile, true))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ServiceChair {
    pub instance_id: u64,
    pub tile: TilePoint,
    pub rotation: u8,
    pub toilet: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ServiceTable {
    pub instance_id: u64,
    pub tile: TilePoint,
    pub item_count_on_tile: u8,
    pub has_table_top_order: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ServiceKitchen {
    pub instance_id: u64,
    pub tile: TilePoint,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ServiceChef {
    pub employee_id: u64,
    pub kitchen_instance_id: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ServiceWaiter {
    pub employee_id: u64,
    pub tile: TilePoint,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceTopologySnapshot {
    pub chair_food_eligible: Vec<u64>,
    pub waiter_chairs: Vec<(u64, Vec<u64>)>,
    pub waiter_kitchens: Vec<(u64, Vec<u64>)>,
    pub chef_chairs: Vec<(u64, Vec<u64>)>,
}

pub fn table_for_chair<'a>(
    chair: ServiceChair,
    tables: &'a [ServiceTable],
) -> Option<&'a ServiceTable> {
    let facing = facing_tile(chair.tile, chair.rotation);
    tables.iter().find(|table| table.tile == facing)
}

pub fn is_table_free(table: ServiceTable) -> bool {
    !table.has_table_top_order && table.item_count_on_tile == 1
}

/// Source-grounded food branch of WorldRestaurantPlay.calculateServableTables.
///
/// A chair becomes food-eligible only when the same waiter can reach both a
/// chef's occupied kitchen target and the customer chair/facing target.
pub fn calculate_food_service_topology(
    grid: &ServiceTopologyGrid,
    chairs: &[ServiceChair],
    kitchens: &[ServiceKitchen],
    chefs: &[ServiceChef],
    waiters: &[ServiceWaiter],
) -> ServiceTopologySnapshot {
    let mut chair_food_eligible = Vec::<u64>::new();
    let mut waiter_chairs = waiters
        .iter()
        .map(|waiter| (waiter.employee_id, Vec::<u64>::new()))
        .collect::<Vec<_>>();
    let mut waiter_kitchens = waiters
        .iter()
        .map(|waiter| (waiter.employee_id, Vec::<u64>::new()))
        .collect::<Vec<_>>();
    let mut chef_chairs = chefs
        .iter()
        .map(|chef| (chef.employee_id, Vec::<u64>::new()))
        .collect::<Vec<_>>();

    for (chef_index, chef) in chefs.iter().enumerate() {
        let Some(kitchen) = kitchens
            .iter()
            .find(|kitchen| kitchen.instance_id == chef.kitchen_instance_id)
        else {
            continue;
        };

        for (waiter_index, waiter) in waiters.iter().enumerate() {
            // calculateServableTables ignores waiters that are not placed on a
            // positive restaurant tile.
            if waiter.tile.x <= 0 || waiter.tile.y <= 0 {
                continue;
            }

            let kitchen_reachable =
                historical_path(grid, waiter.tile, kitchen.tile, true).is_some();
            if kitchen_reachable
                && !waiter_kitchens[waiter_index]
                    .1
                    .contains(&kitchen.instance_id)
            {
                waiter_kitchens[waiter_index].1.push(kitchen.instance_id);
            }

            for chair in chairs {
                let chair_reachable =
                    path_to_customer_chair(grid, waiter.tile, chair.tile, chair.rotation).is_some();
                if !chair_reachable {
                    continue;
                }

                if !waiter_chairs[waiter_index].1.contains(&chair.instance_id) {
                    waiter_chairs[waiter_index].1.push(chair.instance_id);
                }

                if kitchen_reachable {
                    if !chef_chairs[chef_index].1.contains(&chair.instance_id) {
                        chef_chairs[chef_index].1.push(chair.instance_id);
                    }
                    if !chair_food_eligible.contains(&chair.instance_id) {
                        chair_food_eligible.push(chair.instance_id);
                    }
                }
            }
        }
    }

    ServiceTopologySnapshot {
        chair_food_eligible,
        waiter_chairs,
        waiter_kitchens,
        chef_chairs,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TopologyError {
    GridCoordinateOutOfRange,
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
    fn facing_tile_matches_world_restaurant() {
        let origin = TilePoint { x: 5, y: 6 };
        assert_eq!(facing_tile(origin, 0), TilePoint { x: 6, y: 6 });
        assert_eq!(facing_tile(origin, 1), TilePoint { x: 5, y: 7 });
        assert_eq!(facing_tile(origin, 2), TilePoint { x: 4, y: 6 });
        assert_eq!(facing_tile(origin, 3), TilePoint { x: 5, y: 5 });
        assert_eq!(facing_tile(origin, 4), origin);
    }

    #[test]
    fn room_shape_matches_historical_inside_and_outside_bounds() {
        let grid = ServiceTopologyGrid::new(room());
        assert!(!grid.is_tile_out_of_bound(TilePoint { x: 9, y: 9 }));
        assert!(grid.is_tile_out_of_bound(TilePoint { x: 10, y: 9 }));
        assert!(!grid.is_tile_out_of_bound(TilePoint { x: 7, y: 10 }));
        assert!(grid.is_tile_out_of_bound(TilePoint { x: 8, y: 10 }));
        assert!(!grid.is_tile_out_of_bound(TilePoint { x: 0, y: 13 }));
        assert!(grid.is_tile_out_of_bound(TilePoint { x: 0, y: 14 }));
    }

    #[test]
    fn walkability_matches_item_map_and_wall_door_exception() {
        let mut grid = ServiceTopologyGrid::new(room());
        let tile = TilePoint { x: 3, y: 3 };
        assert!(grid.is_walkable(tile));

        grid.set_cell(
            tile,
            TopologyCell {
                wall: false,
                item_count: 1,
                has_door: false,
            },
        )
        .unwrap();
        assert!(!grid.is_walkable(tile));

        grid.set_cell(
            tile,
            TopologyCell {
                wall: true,
                item_count: 1,
                has_door: false,
            },
        )
        .unwrap();
        assert!(!grid.is_walkable(tile));

        grid.set_cell(
            tile,
            TopologyCell {
                wall: true,
                item_count: 1,
                has_door: true,
            },
        )
        .unwrap();
        assert!(grid.is_walkable(tile));
    }

    #[test]
    fn diagonal_path_cannot_cut_between_blocked_orthogonal_tiles() {
        let mut grid = ServiceTopologyGrid::new(room());
        for tile in [TilePoint { x: 2, y: 1 }, TilePoint { x: 1, y: 2 }] {
            grid.set_cell(
                tile,
                TopologyCell {
                    item_count: 1,
                    ..TopologyCell::default()
                },
            )
            .unwrap();
        }

        let path = historical_path(
            &grid,
            TilePoint { x: 1, y: 1 },
            TilePoint { x: 2, y: 2 },
            false,
        );
        assert!(path.is_none());
    }

    #[test]
    fn stop_next_to_destination_bypasses_only_the_final_diagonal_corner_check() {
        let mut grid = ServiceTopologyGrid::new(room());
        let start = TilePoint { x: 1, y: 1 };
        let destination = TilePoint { x: 2, y: 2 };

        // Destination occupancy itself is forced by PathFinder in both modes.
        // Surround it so the only possible entry is the direct diagonal from
        // start. Normal mode still applies isWalkableFrom's corner rule;
        // stopNextToDestTile=true accepts the destination immediately.
        for tile in [
            destination,
            TilePoint { x: 2, y: 1 },
            TilePoint { x: 1, y: 2 },
            TilePoint { x: 3, y: 1 },
            TilePoint { x: 3, y: 2 },
            TilePoint { x: 1, y: 3 },
            TilePoint { x: 2, y: 3 },
            TilePoint { x: 3, y: 3 },
        ] {
            grid.set_cell(
                tile,
                TopologyCell {
                    item_count: 1,
                    ..TopologyCell::default()
                },
            )
            .unwrap();
        }

        assert!(historical_path(&grid, start, destination, false).is_none());

        let path = historical_path(&grid, start, destination, true).unwrap();
        assert_eq!(path.tiles, vec![destination]);
        assert_eq!(path.movement_score, DIAGONAL_SCORE);
        assert!(path.clone().without_destination().tiles.is_empty());
    }

    #[test]
    fn customer_path_prefers_facing_tile_and_falls_back_to_chair() {
        let mut grid = ServiceTopologyGrid::new(room());
        let chair = TilePoint { x: 5, y: 5 };
        let facing = facing_tile(chair, 0);

        grid.set_cell(
            chair,
            TopologyCell {
                item_count: 1,
                ..TopologyCell::default()
            },
        )
        .unwrap();

        let path = path_to_customer_chair(&grid, TilePoint { x: 2, y: 5 }, chair, 0).unwrap();
        assert_eq!(path.tiles.last().copied(), Some(facing));

        // stopNextToDestTile can enter a blocked target from any reachable
        // adjacent tile, so isolate every neighbor of the facing target except
        // the chair itself. The chair remains reachable from the west.
        for tile in [
            facing,
            TilePoint { x: 5, y: 4 },
            TilePoint { x: 6, y: 4 },
            TilePoint { x: 7, y: 4 },
            TilePoint { x: 7, y: 5 },
            TilePoint { x: 5, y: 6 },
            TilePoint { x: 6, y: 6 },
            TilePoint { x: 7, y: 6 },
        ] {
            grid.set_cell(
                tile,
                TopologyCell {
                    item_count: 1,
                    ..TopologyCell::default()
                },
            )
            .unwrap();
        }

        let fallback = path_to_customer_chair(&grid, TilePoint { x: 2, y: 5 }, chair, 0).unwrap();
        assert_eq!(fallback.tiles.last().copied(), Some(chair));
    }

    #[test]
    fn table_lookup_and_free_rule_match_canonical_semantics() {
        let chair = ServiceChair {
            instance_id: 1,
            tile: TilePoint { x: 4, y: 4 },
            rotation: 0,
            toilet: false,
        };
        let table = ServiceTable {
            instance_id: 2,
            tile: TilePoint { x: 5, y: 4 },
            item_count_on_tile: 1,
            has_table_top_order: false,
        };
        assert_eq!(table_for_chair(chair, &[table]), Some(&table));
        assert!(is_table_free(table));
        assert!(!is_table_free(ServiceTable {
            item_count_on_tile: 2,
            ..table
        }));
        assert!(!is_table_free(ServiceTable {
            has_table_top_order: true,
            ..table
        }));
    }

    #[test]
    fn food_eligibility_requires_same_waiter_reachability_to_kitchen_and_chair() {
        let mut grid = ServiceTopologyGrid::new(room());
        let chair = ServiceChair {
            instance_id: 10,
            tile: TilePoint { x: 5, y: 5 },
            rotation: 0,
            toilet: false,
        };
        let kitchen = ServiceKitchen {
            instance_id: 20,
            tile: TilePoint { x: 7, y: 5 },
        };
        let chef = ServiceChef {
            employee_id: 30,
            kitchen_instance_id: 20,
        };
        let waiter = ServiceWaiter {
            employee_id: 40,
            tile: TilePoint { x: 3, y: 5 },
        };

        for tile in [chair.tile, kitchen.tile] {
            grid.set_cell(
                tile,
                TopologyCell {
                    item_count: 1,
                    ..TopologyCell::default()
                },
            )
            .unwrap();
        }

        let open = calculate_food_service_topology(&grid, &[chair], &[kitchen], &[chef], &[waiter]);
        assert_eq!(open.chair_food_eligible, vec![10]);
        assert_eq!(open.waiter_kitchens, vec![(40, vec![20])]);
        assert_eq!(open.waiter_chairs, vec![(40, vec![10])]);
        assert_eq!(open.chef_chairs, vec![(30, vec![10])]);

        // Split the room with an impenetrable occupied column between waiter
        // and kitchen. Chair reachability alone remains insufficient.
        for y in 1..10 {
            grid.set_cell(
                TilePoint { x: 6, y },
                TopologyCell {
                    item_count: 1,
                    ..TopologyCell::default()
                },
            )
            .unwrap();
        }

        let blocked =
            calculate_food_service_topology(&grid, &[chair], &[kitchen], &[chef], &[waiter]);
        assert!(blocked.chair_food_eligible.is_empty());
        assert_eq!(blocked.waiter_chairs, vec![(40, vec![10])]);
        assert_eq!(blocked.waiter_kitchens, vec![(40, vec![])]);
        assert_eq!(blocked.chef_chairs, vec![(30, vec![])]);
    }

    #[test]
    fn waiter_at_zero_border_is_ignored_by_service_calculation() {
        let grid = ServiceTopologyGrid::new(room());
        let snapshot = calculate_food_service_topology(
            &grid,
            &[ServiceChair {
                instance_id: 10,
                tile: TilePoint { x: 5, y: 5 },
                rotation: 0,
                toilet: false,
            }],
            &[ServiceKitchen {
                instance_id: 20,
                tile: TilePoint { x: 7, y: 5 },
            }],
            &[ServiceChef {
                employee_id: 30,
                kitchen_instance_id: 20,
            }],
            &[ServiceWaiter {
                employee_id: 40,
                tile: TilePoint { x: 0, y: 5 },
            }],
        );
        assert!(snapshot.chair_food_eligible.is_empty());
        assert_eq!(snapshot.waiter_chairs, vec![(40, vec![])]);
        assert_eq!(snapshot.waiter_kitchens, vec![(40, vec![])]);
    }
}
