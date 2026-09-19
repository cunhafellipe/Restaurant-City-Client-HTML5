//! Durable identity for one live Restaurant City service lifecycle.
//!
//! This module deliberately has no HTTP/browser API and no economy mutation.
//! It binds one customer/order/chef/waiter assignment to the authoritative
//! restaurant topology and advances only through the already recovered reducer.

use crate::gameplay::{
    ServiceLoopError, ServiceLoopEvent, ServiceLoopState, transition_service_loop,
};
use crate::placement::TilePoint;
use crate::restaurant::{PlacementCatalog, RestaurantSnapshot};
use crate::topology::{
    ServiceChef, ServiceWaiter, calculate_food_service_topology, derive_service_layout,
    is_meal_seat, is_table_free, table_for_chair,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ActiveServiceAssignment {
    pub chair_instance_id: u64,
    pub table_instance_id: u64,
    pub chef_employee_id: u64,
    pub kitchen_instance_id: u64,
    pub waiter_employee_id: u64,
    pub waiter_tile: TilePoint,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ActiveServiceIdentity {
    pub service_id: u64,
    /// Customer and order ids are namespaced identities. For the first native
    /// lifecycle they intentionally share the monotonically allocated service
    /// id, making retries deterministic without inventing extra allocators.
    pub customer_id: u64,
    pub order_id: u64,
    pub chair_instance_id: u64,
    pub table_instance_id: u64,
    pub chef_employee_id: u64,
    pub kitchen_instance_id: u64,
    pub waiter_employee_id: u64,
    pub waiter_tile: TilePoint,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ActiveServiceRecord {
    pub identity: ActiveServiceIdentity,
    pub state: ServiceLoopState,
}

impl ActiveServiceRecord {
    pub fn start(
        service_id: u64,
        assignment: ActiveServiceAssignment,
        restaurant: &RestaurantSnapshot,
        catalog: &PlacementCatalog,
    ) -> Result<Self, ActiveServiceError> {
        if service_id == 0
            || assignment.chair_instance_id == 0
            || assignment.table_instance_id == 0
            || assignment.chef_employee_id == 0
            || assignment.kitchen_instance_id == 0
            || assignment.waiter_employee_id == 0
        {
            return Err(ActiveServiceError::InvalidIdentity);
        }

        let layout =
            derive_service_layout(restaurant, catalog).map_err(|_| ActiveServiceError::Topology)?;

        let chair = layout
            .chairs
            .iter()
            .copied()
            .find(|chair| chair.instance_id == assignment.chair_instance_id)
            .ok_or(ActiveServiceError::ChairUnavailable)?;
        if !is_meal_seat(chair) {
            return Err(ActiveServiceError::ChairUnavailable);
        }

        let table = table_for_chair(chair, &layout.tables)
            .filter(|table| table.instance_id == assignment.table_instance_id)
            .copied()
            .ok_or(ActiveServiceError::TableMismatch)?;
        if !is_table_free(table) {
            return Err(ActiveServiceError::TableUnavailable);
        }

        if !layout
            .kitchens
            .iter()
            .any(|kitchen| kitchen.instance_id == assignment.kitchen_instance_id)
        {
            return Err(ActiveServiceError::KitchenUnavailable);
        }

        let topology = calculate_food_service_topology(
            &layout.grid,
            &layout.chairs,
            &layout.kitchens,
            &[ServiceChef {
                employee_id: assignment.chef_employee_id,
                kitchen_instance_id: assignment.kitchen_instance_id,
            }],
            &[ServiceWaiter {
                employee_id: assignment.waiter_employee_id,
                tile: assignment.waiter_tile,
            }],
        );
        if !topology
            .chair_food_eligible
            .contains(&assignment.chair_instance_id)
        {
            return Err(ActiveServiceError::Unreachable);
        }

        Ok(Self {
            identity: ActiveServiceIdentity {
                service_id,
                customer_id: service_id,
                order_id: service_id,
                chair_instance_id: assignment.chair_instance_id,
                table_instance_id: assignment.table_instance_id,
                chef_employee_id: assignment.chef_employee_id,
                kitchen_instance_id: assignment.kitchen_instance_id,
                waiter_employee_id: assignment.waiter_employee_id,
                waiter_tile: assignment.waiter_tile,
            },
            state: ServiceLoopState::default(),
        })
    }

    pub fn transition(self, event: ServiceLoopEvent) -> Result<Self, ServiceLoopError> {
        let transition = transition_service_loop(self.state, event)?;
        Ok(Self {
            state: transition.state,
            ..self
        })
    }

    pub fn locks_instance(self, instance_id: u64) -> bool {
        instance_id == self.identity.chair_instance_id
            || instance_id == self.identity.table_instance_id
            || instance_id == self.identity.kitchen_instance_id
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActiveServiceError {
    InvalidIdentity,
    Topology,
    ChairUnavailable,
    TableMismatch,
    TableUnavailable,
    KitchenUnavailable,
    Unreachable,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::placement::{Footprint, PlacementFlags, RoomDimensions};
    use crate::restaurant::{
        ItemPlacementDefinition, PlacementIntent, RestaurantState, ServiceItemFlags,
    };

    fn fixture() -> (RestaurantSnapshot, PlacementCatalog) {
        let mut catalog = PlacementCatalog::new([
            ItemPlacementDefinition {
                item_id: 11,
                footprint: Footprint {
                    size_x: 1,
                    size_y: 1,
                },
                rotation_count: 4,
                flags: PlacementFlags::default(),
            },
            ItemPlacementDefinition {
                item_id: 12,
                footprint: Footprint {
                    size_x: 1,
                    size_y: 1,
                },
                rotation_count: 4,
                flags: PlacementFlags::default(),
            },
            ItemPlacementDefinition {
                item_id: 13,
                footprint: Footprint {
                    size_x: 1,
                    size_y: 1,
                },
                rotation_count: 4,
                flags: PlacementFlags::default(),
            },
        ])
        .unwrap();
        catalog.set_service_flags_for_test(
            11,
            ServiceItemFlags {
                chair_item: true,
                ..ServiceItemFlags::default()
            },
        );
        catalog.set_service_flags_for_test(
            12,
            ServiceItemFlags {
                table_item: true,
                ..ServiceItemFlags::default()
            },
        );
        catalog.set_service_flags_for_test(
            13,
            ServiceItemFlags {
                kitchen: true,
                ..ServiceItemFlags::default()
            },
        );

        let mut restaurant = RestaurantState::new(RoomDimensions {
            inside_x: 8,
            inside_y: 8,
            outside_x: 0,
            outside_y: 0,
        });
        restaurant
            .place(
                &catalog,
                PlacementIntent {
                    item_id: 11,
                    tile: TilePoint { x: 2, y: 2 },
                    rotation: 0,
                },
            )
            .unwrap();
        restaurant
            .place(
                &catalog,
                PlacementIntent {
                    item_id: 12,
                    tile: TilePoint { x: 3, y: 2 },
                    rotation: 0,
                },
            )
            .unwrap();
        restaurant
            .place(
                &catalog,
                PlacementIntent {
                    item_id: 13,
                    tile: TilePoint { x: 6, y: 4 },
                    rotation: 0,
                },
            )
            .unwrap();
        (restaurant.snapshot(), catalog)
    }

    #[test]
    fn start_binds_only_a_reachable_canonical_service_chain() {
        let (restaurant, catalog) = fixture();
        let record = ActiveServiceRecord::start(
            1,
            ActiveServiceAssignment {
                chair_instance_id: 1,
                table_instance_id: 2,
                chef_employee_id: 101,
                kitchen_instance_id: 3,
                waiter_employee_id: 201,
                waiter_tile: TilePoint { x: 4, y: 4 },
            },
            &restaurant,
            &catalog,
        )
        .unwrap();

        assert_eq!(record.identity.customer_id, 1);
        assert_eq!(record.identity.order_id, 1);
        assert_eq!(record.state, ServiceLoopState::default());
        assert!(record.locks_instance(1));
        assert!(record.locks_instance(2));
        assert!(record.locks_instance(3));
    }

    #[test]
    fn start_rejects_a_chair_table_mismatch() {
        let (restaurant, catalog) = fixture();
        assert_eq!(
            ActiveServiceRecord::start(
                1,
                ActiveServiceAssignment {
                    chair_instance_id: 1,
                    table_instance_id: 3,
                    chef_employee_id: 101,
                    kitchen_instance_id: 3,
                    waiter_employee_id: 201,
                    waiter_tile: TilePoint { x: 4, y: 4 },
                },
                &restaurant,
                &catalog,
            ),
            Err(ActiveServiceError::TableMismatch)
        );
    }
}
