//! Canonical Restaurant City 0.9.143a gameplay rules that must remain
//! product-authoritative.
//!
//! Browser state may predict these values for presentation, but only this
//! server-side domain is allowed to turn a completed gameplay action into a
//! wallet mutation.

use crate::domain::Command;
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

pub fn canonical_chef_base_cook_duration_ms(
    work_percent: f64,
) -> Result<u64, GameplayRuleError> {
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
        assert_eq!(canonical_customer_spawn_delay_ms(100.0, 0).unwrap(), 12_000.0);
        assert_eq!(canonical_customer_spawn_delay_ms(100.0, -3000).unwrap(), 9_000.0);
        assert!(
            (canonical_customer_spawn_delay_ms(600.0, 0).unwrap()
                - 60_000.0 / (550.0 * 0.05))
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
