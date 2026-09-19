//! Canonical Restaurant City 0.9.143a gameplay rules that must remain
//! product-authoritative.
//!
//! Browser state may predict these values for presentation, but only this
//! server-side domain is allowed to turn a completed gameplay action into a
//! wallet mutation.

use crate::domain::Command;
use serde::{Deserialize, Serialize};
use std::fmt;

pub const CUSTOMER_DECISION_MS: u64 = 1_000;
pub const CUSTOMER_WAIT_ORDER_MS: u64 = 10_000;
pub const CUSTOMER_WAIT_FOOD_MS: u64 = 120_000;
pub const CUSTOMER_EATING_MS: u64 = 25_000;
pub const CUSTOMER_PAYING_MS: u64 = 2_000;
pub const CHEF_COOK_MIN_MS: u64 = 16_000;
pub const CHEF_COOK_MAX_MS: u64 = 32_000;
pub const WAITER_ACTION_MIN_MS: u64 = 2_000;
pub const WAITER_ACTION_MAX_MS: u64 = 6_000;
pub const CUSTOMERS_PER_MINUTE_PER_DEMAND: f64 = 0.05;
pub const MAX_DEMAND: f64 = 550.0;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MealReward {
    pub coins: u64,
    /// Restaurant City stores gourmet points in tenths:
    /// GameWorld.addGourmetPoints(value) adds floor(value * 10).
    pub gourmet_point_tenths: u64,
}

impl MealReward {
    pub fn into_command(self) -> Command {
        Command::SettleMeal {
            coins: self.coins,
            gourmet_point_tenths: self.gourmet_point_tenths,
        }
    }
}

pub fn canonical_meal_reward(
    recipe_cost: u64,
    recipe_level: u32,
) -> Result<MealReward, GameplayRuleError> {
    if recipe_level == 0 {
        return Err(GameplayRuleError::InvalidRecipeLevel);
    }

    // Historical display reward:
    //   1 + 0.2 * (recipe.level - 1)
    // Historical storage:
    //   floor(display * 10)
    // For integral levels >= 1 this is exactly 10 + 2 * (level - 1).
    let level_offset = u64::from(recipe_level - 1);
    let gourmet_point_tenths = level_offset
        .checked_mul(2)
        .and_then(|value| value.checked_add(10))
        .ok_or(GameplayRuleError::ArithmeticOverflow)?;

    Ok(MealReward {
        coins: recipe_cost,
        gourmet_point_tenths,
    })
}

pub fn canonical_customer_spawn_delay_ms(
    demand_points: f64,
    jitter_ms: i32,
) -> Result<f64, GameplayRuleError> {
    if !demand_points.is_finite() || demand_points <= 0.0 {
        return Err(GameplayRuleError::InvalidDemand);
    }
    if !(-3000..3000).contains(&jitter_ms) {
        return Err(GameplayRuleError::InvalidJitter);
    }

    let demand = demand_points.min(MAX_DEMAND);
    Ok(60_000.0 / (demand * CUSTOMERS_PER_MINUTE_PER_DEMAND) + f64::from(jitter_ms))
}

pub fn canonical_chef_base_cook_duration_ms(work_percent: f64) -> Result<u64, GameplayRuleError> {
    if !work_percent.is_finite() || !(0.0..=100.0).contains(&work_percent) {
        return Err(GameplayRuleError::InvalidWorkPercent);
    }

    if work_percent >= 80.0 {
        return Ok(CHEF_COOK_MIN_MS);
    }
    if work_percent < 20.0 {
        return Ok(CHEF_COOK_MAX_MS);
    }

    let interpolated = CHEF_COOK_MAX_MS as f64
        - (CHEF_COOK_MAX_MS - CHEF_COOK_MIN_MS) as f64 * (work_percent - 20.0) / 60.0;

    // AS3 assignment to an int truncates toward zero for this positive range.
    Ok(interpolated.trunc() as u64)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CustomerServiceState {
    Admitted,
    WalkingToChair,
    Deciding,
    Waiting,
    WaitingForFood,
    Eating,
    Paying,
    Leaving,
    Left,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderServiceState {
    Created,
    Queued,
    Cooking,
    Completed,
    WaiterCollecting,
    Serving,
    EmptyPlate,
    Settled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceLoopState {
    pub customer: CustomerServiceState,
    pub order: OrderServiceState,
    pub customer_timer_ms: Option<u64>,
    pub order_timer_ms: Option<u64>,
}

impl Default for ServiceLoopState {
    fn default() -> Self {
        Self {
            customer: CustomerServiceState::Admitted,
            order: OrderServiceState::Created,
            customer_timer_ms: None,
            order_timer_ms: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceLoopEvent {
    StartChairWalk,
    ReachChair,
    DecisionElapsed,
    ChefAssigned { cook_duration_ms: u64 },
    CookElapsed,
    WaiterCollecting { action_delay_ms: u64 },
    WaiterActionElapsed,
    Served,
    EatingElapsed,
    PayingElapsed,
    PlateCleared,
    Left,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ServiceLoopEffect {
    SettleMeal,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ServiceLoopTransition {
    pub state: ServiceLoopState,
    pub effect: Option<ServiceLoopEffect>,
}

pub fn transition_service_loop(
    state: ServiceLoopState,
    event: ServiceLoopEvent,
) -> Result<ServiceLoopTransition, ServiceLoopError> {
    use CustomerServiceState as Customer;
    use OrderServiceState as Order;
    use ServiceLoopEvent as Event;

    let transition = match event {
        Event::StartChairWalk => {
            require_service_pair(state, Customer::Admitted, Order::Created)?;
            ServiceLoopTransition {
                state: ServiceLoopState {
                    customer: Customer::WalkingToChair,
                    ..state
                },
                effect: None,
            }
        }
        Event::ReachChair => {
            require_service_pair(state, Customer::WalkingToChair, Order::Created)?;
            ServiceLoopTransition {
                state: ServiceLoopState {
                    customer: Customer::Deciding,
                    customer_timer_ms: Some(CUSTOMER_DECISION_MS),
                    ..state
                },
                effect: None,
            }
        }
        Event::DecisionElapsed => {
            require_service_pair(state, Customer::Deciding, Order::Created)?;
            ServiceLoopTransition {
                state: ServiceLoopState {
                    customer: Customer::Waiting,
                    order: Order::Queued,
                    customer_timer_ms: Some(CUSTOMER_WAIT_ORDER_MS),
                    order_timer_ms: None,
                },
                effect: None,
            }
        }
        Event::ChefAssigned { cook_duration_ms } => {
            require_service_pair(state, Customer::Waiting, Order::Queued)?;
            require_duration(cook_duration_ms, CHEF_COOK_MIN_MS, CHEF_COOK_MAX_MS)?;
            ServiceLoopTransition {
                state: ServiceLoopState {
                    customer: Customer::WaitingForFood,
                    order: Order::Cooking,
                    customer_timer_ms: Some(CUSTOMER_WAIT_FOOD_MS),
                    order_timer_ms: Some(cook_duration_ms),
                },
                effect: None,
            }
        }
        Event::CookElapsed => {
            require_service_pair(state, Customer::WaitingForFood, Order::Cooking)?;
            ServiceLoopTransition {
                state: ServiceLoopState {
                    order: Order::Completed,
                    order_timer_ms: None,
                    ..state
                },
                effect: None,
            }
        }
        Event::WaiterCollecting { action_delay_ms } => {
            require_service_pair(state, Customer::WaitingForFood, Order::Completed)?;
            require_duration(action_delay_ms, WAITER_ACTION_MIN_MS, WAITER_ACTION_MAX_MS)?;
            ServiceLoopTransition {
                state: ServiceLoopState {
                    order: Order::WaiterCollecting,
                    order_timer_ms: Some(action_delay_ms),
                    ..state
                },
                effect: None,
            }
        }
        Event::WaiterActionElapsed => {
            require_service_pair(state, Customer::WaitingForFood, Order::WaiterCollecting)?;
            ServiceLoopTransition {
                state: ServiceLoopState {
                    order: Order::Serving,
                    order_timer_ms: None,
                    ..state
                },
                effect: None,
            }
        }
        Event::Served => {
            require_service_pair(state, Customer::WaitingForFood, Order::Serving)?;
            ServiceLoopTransition {
                state: ServiceLoopState {
                    customer: Customer::Eating,
                    customer_timer_ms: Some(CUSTOMER_EATING_MS),
                    ..state
                },
                effect: None,
            }
        }
        Event::EatingElapsed => {
            require_service_pair(state, Customer::Eating, Order::Serving)?;
            ServiceLoopTransition {
                state: ServiceLoopState {
                    customer: Customer::Paying,
                    order: Order::EmptyPlate,
                    customer_timer_ms: Some(CUSTOMER_PAYING_MS),
                    order_timer_ms: None,
                },
                effect: None,
            }
        }
        Event::PayingElapsed => {
            if state.customer != Customer::Paying {
                return Err(ServiceLoopError::InvalidTransition);
            }
            ServiceLoopTransition {
                state: ServiceLoopState {
                    customer: Customer::Leaving,
                    customer_timer_ms: None,
                    ..state
                },
                effect: None,
            }
        }
        Event::PlateCleared => {
            if state.order == Order::Settled {
                ServiceLoopTransition {
                    state,
                    effect: None,
                }
            } else {
                if state.order != Order::EmptyPlate {
                    return Err(ServiceLoopError::InvalidTransition);
                }
                ServiceLoopTransition {
                    state: ServiceLoopState {
                        order: Order::Settled,
                        order_timer_ms: None,
                        ..state
                    },
                    effect: Some(ServiceLoopEffect::SettleMeal),
                }
            }
        }
        Event::Left => {
            if state.customer != Customer::Leaving {
                return Err(ServiceLoopError::InvalidTransition);
            }
            ServiceLoopTransition {
                state: ServiceLoopState {
                    customer: Customer::Left,
                    customer_timer_ms: None,
                    ..state
                },
                effect: None,
            }
        }
    };

    Ok(transition)
}

fn require_service_pair(
    state: ServiceLoopState,
    customer: CustomerServiceState,
    order: OrderServiceState,
) -> Result<(), ServiceLoopError> {
    if state.customer == customer && state.order == order {
        Ok(())
    } else {
        Err(ServiceLoopError::InvalidTransition)
    }
}

fn require_duration(value: u64, min: u64, max: u64) -> Result<(), ServiceLoopError> {
    if (min..=max).contains(&value) {
        Ok(())
    } else {
        Err(ServiceLoopError::InvalidDuration)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ServiceLoopError {
    InvalidTransition,
    InvalidDuration,
}

impl fmt::Display for ServiceLoopError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for ServiceLoopError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GameplayRuleError {
    InvalidRecipeLevel,
    InvalidDemand,
    InvalidJitter,
    InvalidWorkPercent,
    ArithmeticOverflow,
}

impl fmt::Display for GameplayRuleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for GameplayRuleError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_meal_reward_uses_gourmet_point_tenths() {
        assert_eq!(
            canonical_meal_reward(25, 1).unwrap(),
            MealReward {
                coins: 25,
                gourmet_point_tenths: 10,
            }
        );
        assert_eq!(
            canonical_meal_reward(60, 5).unwrap(),
            MealReward {
                coins: 60,
                gourmet_point_tenths: 18,
            }
        );
        assert_eq!(
            canonical_meal_reward(1, 0),
            Err(GameplayRuleError::InvalidRecipeLevel)
        );
    }

    #[test]
    fn customer_spawn_delay_matches_recovered_formula_and_cap() {
        assert_eq!(
            canonical_customer_spawn_delay_ms(100.0, 0).unwrap(),
            12_000.0
        );
        assert_eq!(
            canonical_customer_spawn_delay_ms(100.0, -3000).unwrap(),
            9_000.0
        );
        assert!(
            (canonical_customer_spawn_delay_ms(600.0, 0).unwrap() - 60_000.0 / (550.0 * 0.05))
                .abs()
                < f64::EPSILON
        );
        assert_eq!(
            canonical_customer_spawn_delay_ms(0.0, 0),
            Err(GameplayRuleError::InvalidDemand)
        );
        assert_eq!(
            canonical_customer_spawn_delay_ms(100.0, 3000),
            Err(GameplayRuleError::InvalidJitter)
        );
    }

    #[test]
    fn service_loop_replays_the_recovered_happy_path_and_emits_settlement_once() {
        let mut state = ServiceLoopState::default();

        for event in [
            ServiceLoopEvent::StartChairWalk,
            ServiceLoopEvent::ReachChair,
            ServiceLoopEvent::DecisionElapsed,
            ServiceLoopEvent::ChefAssigned {
                cook_duration_ms: 24_000,
            },
            ServiceLoopEvent::CookElapsed,
            ServiceLoopEvent::WaiterCollecting {
                action_delay_ms: 4_000,
            },
            ServiceLoopEvent::WaiterActionElapsed,
            ServiceLoopEvent::Served,
            ServiceLoopEvent::EatingElapsed,
        ] {
            state = transition_service_loop(state, event).unwrap().state;
        }

        assert_eq!(state.customer, CustomerServiceState::Paying);
        assert_eq!(state.order, OrderServiceState::EmptyPlate);
        assert_eq!(state.customer_timer_ms, Some(2_000));

        let settled = transition_service_loop(state, ServiceLoopEvent::PlateCleared).unwrap();
        assert_eq!(settled.effect, Some(ServiceLoopEffect::SettleMeal));
        state = settled.state;

        let duplicate = transition_service_loop(state, ServiceLoopEvent::PlateCleared).unwrap();
        assert_eq!(duplicate.effect, None);
        assert_eq!(duplicate.state, state);

        state = transition_service_loop(state, ServiceLoopEvent::PayingElapsed)
            .unwrap()
            .state;
        state = transition_service_loop(state, ServiceLoopEvent::Left)
            .unwrap()
            .state;
        assert_eq!(state.customer, CustomerServiceState::Left);
        assert_eq!(state.order, OrderServiceState::Settled);
    }

    #[test]
    fn plate_can_be_settled_after_customer_has_left() {
        let mut state = ServiceLoopState {
            customer: CustomerServiceState::Paying,
            order: OrderServiceState::EmptyPlate,
            customer_timer_ms: Some(CUSTOMER_PAYING_MS),
            order_timer_ms: None,
        };
        state = transition_service_loop(state, ServiceLoopEvent::PayingElapsed)
            .unwrap()
            .state;
        state = transition_service_loop(state, ServiceLoopEvent::Left)
            .unwrap()
            .state;

        let transition = transition_service_loop(state, ServiceLoopEvent::PlateCleared).unwrap();
        assert_eq!(transition.effect, Some(ServiceLoopEffect::SettleMeal));
        assert_eq!(transition.state.customer, CustomerServiceState::Left);
        assert_eq!(transition.state.order, OrderServiceState::Settled);
    }

    #[test]
    fn service_loop_rejects_early_settlement_and_tampered_delays() {
        assert_eq!(
            transition_service_loop(ServiceLoopState::default(), ServiceLoopEvent::PlateCleared,),
            Err(ServiceLoopError::InvalidTransition)
        );

        let state = ServiceLoopState {
            customer: CustomerServiceState::Waiting,
            order: OrderServiceState::Queued,
            customer_timer_ms: Some(CUSTOMER_WAIT_ORDER_MS),
            order_timer_ms: None,
        };
        assert_eq!(
            transition_service_loop(
                state,
                ServiceLoopEvent::ChefAssigned {
                    cook_duration_ms: CHEF_COOK_MIN_MS - 1,
                },
            ),
            Err(ServiceLoopError::InvalidDuration)
        );
    }

    #[test]
    fn chef_cook_duration_matches_recovered_work_time_interpolation() {
        assert_eq!(canonical_chef_base_cook_duration_ms(0.0).unwrap(), 32_000);
        assert_eq!(canonical_chef_base_cook_duration_ms(20.0).unwrap(), 32_000);
        assert_eq!(canonical_chef_base_cook_duration_ms(50.0).unwrap(), 24_000);
        assert_eq!(canonical_chef_base_cook_duration_ms(80.0).unwrap(), 16_000);
        assert_eq!(canonical_chef_base_cook_duration_ms(100.0).unwrap(), 16_000);
        assert_eq!(
            canonical_chef_base_cook_duration_ms(100.1),
            Err(GameplayRuleError::InvalidWorkPercent)
        );
    }
}
