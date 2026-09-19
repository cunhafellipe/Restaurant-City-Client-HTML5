//! Persisted-time semantics for the authoritative Restaurant City service loop.
//!
//! Browser animation clocks are never gameplay authority. This module couples
//! the already recovered reducer to server timestamps while keeping timer-driven
//! events separate from path/action completion events.

use crate::gameplay::{
    CustomerServiceState, OrderServiceState, ServiceLoopEffect, ServiceLoopError, ServiceLoopEvent,
    ServiceLoopState, transition_service_loop,
};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ServiceDeadlines {
    pub customer_deadline_at_ms: Option<u64>,
    pub order_deadline_at_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DueServiceEvent {
    pub event: ServiceLoopEvent,
    /// Canonical event time is the expired deadline, not the later wall-clock
    /// observation time. This makes reopen/catch-up deterministic.
    pub effective_at_ms: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TimedServiceTransition {
    pub state: ServiceLoopState,
    pub effect: Option<ServiceLoopEffect>,
    pub deadlines: ServiceDeadlines,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimedServiceCatchUp {
    pub state: ServiceLoopState,
    pub deadlines: ServiceDeadlines,
    pub applied: Vec<DueServiceEvent>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ServiceTimingError {
    Reducer(ServiceLoopError),
    TimingUnanchored,
    MissingCustomerDeadline,
    MissingOrderDeadline,
    UnexpectedCustomerDeadline,
    UnexpectedOrderDeadline,
    DeadlineOverflow,
    ClockBeforeUnixEpoch,
    ClockOverflow,
    CatchUpLoop,
}

pub trait ServiceTimeSource: Send + Sync {
    fn now_ms(&self) -> Result<u64, ServiceTimingError>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemServiceTimeSource;

impl ServiceTimeSource for SystemServiceTimeSource {
    fn now_ms(&self) -> Result<u64, ServiceTimingError> {
        let duration = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ServiceTimingError::ClockBeforeUnixEpoch)?;
        u64::try_from(duration.as_millis()).map_err(|_| ServiceTimingError::ClockOverflow)
    }
}

fn deadline_at(
    effective_at_ms: u64,
    duration_ms: Option<u64>,
) -> Result<Option<u64>, ServiceTimingError> {
    duration_ms
        .map(|duration| {
            effective_at_ms
                .checked_add(duration)
                .ok_or(ServiceTimingError::DeadlineOverflow)
        })
        .transpose()
}

pub fn anchor_service_deadlines(
    state: ServiceLoopState,
    effective_at_ms: u64,
) -> Result<ServiceDeadlines, ServiceTimingError> {
    let deadlines = ServiceDeadlines {
        customer_deadline_at_ms: deadline_at(effective_at_ms, state.customer_timer_ms)?,
        order_deadline_at_ms: deadline_at(effective_at_ms, state.order_timer_ms)?,
    };
    validate_service_deadlines(state, deadlines)?;
    Ok(deadlines)
}

pub fn validate_service_deadlines(
    state: ServiceLoopState,
    deadlines: ServiceDeadlines,
) -> Result<(), ServiceTimingError> {
    match (state.customer_timer_ms, deadlines.customer_deadline_at_ms) {
        (Some(_), None) => return Err(ServiceTimingError::MissingCustomerDeadline),
        (None, Some(_)) => return Err(ServiceTimingError::UnexpectedCustomerDeadline),
        _ => {}
    }
    match (state.order_timer_ms, deadlines.order_deadline_at_ms) {
        (Some(_), None) => return Err(ServiceTimingError::MissingOrderDeadline),
        (None, Some(_)) => return Err(ServiceTimingError::UnexpectedOrderDeadline),
        _ => {}
    }
    Ok(())
}

/// Apply one authoritative reducer event and update only the deadlines whose
/// historical timers actually start/reset at that event.
///
/// A timer that keeps running across a reducer event preserves its absolute
/// deadline. In particular the 120s customer food-wait deadline is not reset by
/// CookElapsed / WaiterCollecting / WaiterActionElapsed.
pub fn transition_timed_service(
    state: ServiceLoopState,
    deadlines: ServiceDeadlines,
    event: ServiceLoopEvent,
    effective_at_ms: u64,
) -> Result<TimedServiceTransition, ServiceTimingError> {
    validate_service_deadlines(state, deadlines)?;
    let transition = transition_service_loop(state, event).map_err(ServiceTimingError::Reducer)?;
    let next = transition.state;
    let mut next_deadlines = deadlines;

    match event {
        ServiceLoopEvent::StartChairWalk => {
            next_deadlines = ServiceDeadlines::default();
        }
        ServiceLoopEvent::ReachChair => {
            next_deadlines.customer_deadline_at_ms =
                deadline_at(effective_at_ms, next.customer_timer_ms)?;
            next_deadlines.order_deadline_at_ms = None;
        }
        ServiceLoopEvent::DecisionElapsed => {
            next_deadlines.customer_deadline_at_ms =
                deadline_at(effective_at_ms, next.customer_timer_ms)?;
            next_deadlines.order_deadline_at_ms = None;
        }
        ServiceLoopEvent::ChefAssigned { .. } => {
            next_deadlines.customer_deadline_at_ms =
                deadline_at(effective_at_ms, next.customer_timer_ms)?;
            next_deadlines.order_deadline_at_ms =
                deadline_at(effective_at_ms, next.order_timer_ms)?;
        }
        ServiceLoopEvent::CookElapsed => {
            next_deadlines.order_deadline_at_ms = None;
        }
        ServiceLoopEvent::WaiterCollecting { .. } => {
            next_deadlines.order_deadline_at_ms =
                deadline_at(effective_at_ms, next.order_timer_ms)?;
        }
        ServiceLoopEvent::WaiterActionElapsed => {
            next_deadlines.order_deadline_at_ms = None;
        }
        ServiceLoopEvent::Served => {
            next_deadlines.customer_deadline_at_ms =
                deadline_at(effective_at_ms, next.customer_timer_ms)?;
            next_deadlines.order_deadline_at_ms = None;
        }
        ServiceLoopEvent::EatingElapsed => {
            next_deadlines.customer_deadline_at_ms =
                deadline_at(effective_at_ms, next.customer_timer_ms)?;
            next_deadlines.order_deadline_at_ms = None;
        }
        ServiceLoopEvent::PayingElapsed => {
            next_deadlines.customer_deadline_at_ms = None;
        }
        ServiceLoopEvent::PlateCleared => {
            next_deadlines.order_deadline_at_ms = None;
        }
        ServiceLoopEvent::Left => {
            next_deadlines.customer_deadline_at_ms = None;
        }
    }

    validate_service_deadlines(next, next_deadlines)?;
    Ok(TimedServiceTransition {
        state: next,
        effect: transition.effect,
        deadlines: next_deadlines,
    })
}

/// Return only timer-driven *success* events whose historical precondition is
/// already represented by the reducer state.
///
/// Waiting / WaitingForFood customer deadlines are patience timeouts, not
/// success transitions, and deliberately do not auto-advance here until their
/// unhappy/abandon paths are recovered into the reducer.
pub fn due_service_event(
    state: ServiceLoopState,
    deadlines: ServiceDeadlines,
    now_ms: u64,
) -> Result<Option<DueServiceEvent>, ServiceTimingError> {
    validate_service_deadlines(state, deadlines)?;

    let candidate = match (state.customer, state.order) {
        (CustomerServiceState::Deciding, OrderServiceState::Created) => deadlines
            .customer_deadline_at_ms
            .map(|effective_at_ms| DueServiceEvent {
                event: ServiceLoopEvent::DecisionElapsed,
                effective_at_ms,
            }),
        (CustomerServiceState::WaitingForFood, OrderServiceState::Cooking) => deadlines
            .order_deadline_at_ms
            .map(|effective_at_ms| DueServiceEvent {
                event: ServiceLoopEvent::CookElapsed,
                effective_at_ms,
            }),
        (CustomerServiceState::WaitingForFood, OrderServiceState::WaiterCollecting) => deadlines
            .order_deadline_at_ms
            .map(|effective_at_ms| DueServiceEvent {
                event: ServiceLoopEvent::WaiterActionElapsed,
                effective_at_ms,
            }),
        (CustomerServiceState::Eating, OrderServiceState::Serving) => deadlines
            .customer_deadline_at_ms
            .map(|effective_at_ms| DueServiceEvent {
                event: ServiceLoopEvent::EatingElapsed,
                effective_at_ms,
            }),
        (CustomerServiceState::Paying, _) => {
            deadlines
                .customer_deadline_at_ms
                .map(|effective_at_ms| DueServiceEvent {
                    event: ServiceLoopEvent::PayingElapsed,
                    effective_at_ms,
                })
        }
        _ => None,
    };

    Ok(candidate.filter(|due| due.effective_at_ms <= now_ms))
}

/// Deterministically catch up adjacent timer-driven phases.
///
/// The next phase starts at the expired deadline that caused the transition,
/// rather than at `now_ms`. A process that was offline for 30 seconds while a
/// customer was eating therefore catches up 25s eating + 2s paying exactly,
/// then stops at Leaving because leaving is path-driven.
pub fn catch_up_timed_service(
    mut state: ServiceLoopState,
    mut deadlines: ServiceDeadlines,
    now_ms: u64,
) -> Result<TimedServiceCatchUp, ServiceTimingError> {
    let mut applied = Vec::new();

    for _ in 0..8 {
        let Some(due) = due_service_event(state, deadlines, now_ms)? else {
            return Ok(TimedServiceCatchUp {
                state,
                deadlines,
                applied,
            });
        };
        let transitioned =
            transition_timed_service(state, deadlines, due.event, due.effective_at_ms)?;
        if transitioned.effect.is_some() {
            // No currently auto-due event emits an economy effect. Keep this
            // fail-closed if future reducer work changes that assumption.
            return Err(ServiceTimingError::CatchUpLoop);
        }
        state = transitioned.state;
        deadlines = transitioned.deadlines;
        applied.push(due);
    }

    Err(ServiceTimingError::CatchUpLoop)
}

pub fn remaining_ms(deadline_at_ms: Option<u64>, now_ms: u64) -> Option<u64> {
    deadline_at_ms.map(|deadline| deadline.saturating_sub(now_ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(
        state: &mut ServiceLoopState,
        deadlines: &mut ServiceDeadlines,
        event: ServiceLoopEvent,
        at: u64,
    ) {
        let next = transition_timed_service(*state, *deadlines, event, at).unwrap();
        assert_eq!(next.effect, None);
        *state = next.state;
        *deadlines = next.deadlines;
    }

    #[test]
    fn legacy_timer_state_can_be_anchored_only_from_an_explicit_server_time() {
        let state = ServiceLoopState {
            customer: CustomerServiceState::WaitingForFood,
            order: OrderServiceState::Cooking,
            customer_timer_ms: Some(120_000),
            order_timer_ms: Some(24_000),
        };
        assert_eq!(
            anchor_service_deadlines(state, 1_000).unwrap(),
            ServiceDeadlines {
                customer_deadline_at_ms: Some(121_000),
                order_deadline_at_ms: Some(25_000),
            }
        );
    }

    #[test]
    fn chair_arrival_starts_decision_deadline_and_due_event_uses_exact_deadline() {
        let mut state = ServiceLoopState::default();
        let mut deadlines = ServiceDeadlines::default();

        apply(
            &mut state,
            &mut deadlines,
            ServiceLoopEvent::StartChairWalk,
            10_000,
        );
        apply(
            &mut state,
            &mut deadlines,
            ServiceLoopEvent::ReachChair,
            12_000,
        );

        assert_eq!(deadlines.customer_deadline_at_ms, Some(13_000));
        assert_eq!(due_service_event(state, deadlines, 12_999).unwrap(), None);
        assert_eq!(
            due_service_event(state, deadlines, 13_000).unwrap(),
            Some(DueServiceEvent {
                event: ServiceLoopEvent::DecisionElapsed,
                effective_at_ms: 13_000,
            })
        );
    }

    #[test]
    fn waiting_patience_deadline_does_not_invent_a_success_transition() {
        let mut state = ServiceLoopState::default();
        let mut deadlines = ServiceDeadlines::default();
        apply(
            &mut state,
            &mut deadlines,
            ServiceLoopEvent::StartChairWalk,
            1_000,
        );
        apply(
            &mut state,
            &mut deadlines,
            ServiceLoopEvent::ReachChair,
            2_000,
        );
        apply(
            &mut state,
            &mut deadlines,
            ServiceLoopEvent::DecisionElapsed,
            3_000,
        );

        assert_eq!(state.customer, CustomerServiceState::Waiting);
        assert_eq!(deadlines.customer_deadline_at_ms, Some(13_000));
        assert_eq!(due_service_event(state, deadlines, 99_000).unwrap(), None);
    }

    #[test]
    fn food_wait_deadline_survives_cook_and_waiter_action_transitions() {
        let state = ServiceLoopState {
            customer: CustomerServiceState::Waiting,
            order: OrderServiceState::Queued,
            customer_timer_ms: Some(10_000),
            order_timer_ms: None,
        };
        let deadlines = ServiceDeadlines {
            customer_deadline_at_ms: Some(20_000),
            order_deadline_at_ms: None,
        };

        let cooking = transition_timed_service(
            state,
            deadlines,
            ServiceLoopEvent::ChefAssigned {
                cook_duration_ms: 24_000,
            },
            12_000,
        )
        .unwrap();
        assert_eq!(cooking.deadlines.customer_deadline_at_ms, Some(132_000));
        assert_eq!(cooking.deadlines.order_deadline_at_ms, Some(36_000));

        let completed = transition_timed_service(
            cooking.state,
            cooking.deadlines,
            ServiceLoopEvent::CookElapsed,
            36_000,
        )
        .unwrap();
        assert_eq!(completed.deadlines.customer_deadline_at_ms, Some(132_000));
        assert_eq!(completed.deadlines.order_deadline_at_ms, None);

        let collecting = transition_timed_service(
            completed.state,
            completed.deadlines,
            ServiceLoopEvent::WaiterCollecting {
                action_delay_ms: 4_000,
            },
            40_000,
        )
        .unwrap();
        assert_eq!(collecting.deadlines.customer_deadline_at_ms, Some(132_000));
        assert_eq!(collecting.deadlines.order_deadline_at_ms, Some(44_000));

        let serving = transition_timed_service(
            collecting.state,
            collecting.deadlines,
            ServiceLoopEvent::WaiterActionElapsed,
            44_000,
        )
        .unwrap();
        assert_eq!(serving.deadlines.customer_deadline_at_ms, Some(132_000));
        assert_eq!(serving.deadlines.order_deadline_at_ms, None);
    }

    #[test]
    fn offline_eating_catches_up_through_paying_but_stops_at_path_driven_leaving() {
        let state = ServiceLoopState {
            customer: CustomerServiceState::Eating,
            order: OrderServiceState::Serving,
            customer_timer_ms: Some(25_000),
            order_timer_ms: None,
        };
        let deadlines = ServiceDeadlines {
            customer_deadline_at_ms: Some(125_000),
            order_deadline_at_ms: None,
        };

        let caught = catch_up_timed_service(state, deadlines, 130_000).unwrap();
        assert_eq!(
            caught.applied,
            vec![
                DueServiceEvent {
                    event: ServiceLoopEvent::EatingElapsed,
                    effective_at_ms: 125_000,
                },
                DueServiceEvent {
                    event: ServiceLoopEvent::PayingElapsed,
                    effective_at_ms: 127_000,
                },
            ]
        );
        assert_eq!(caught.state.customer, CustomerServiceState::Leaving);
        assert_eq!(caught.state.order, OrderServiceState::EmptyPlate);
        assert_eq!(caught.deadlines, ServiceDeadlines::default());
    }

    #[test]
    fn invalid_deadline_shape_fails_closed() {
        let state = ServiceLoopState {
            customer: CustomerServiceState::Deciding,
            order: OrderServiceState::Created,
            customer_timer_ms: Some(1_000),
            order_timer_ms: None,
        };
        assert_eq!(
            due_service_event(state, ServiceDeadlines::default(), 10_000),
            Err(ServiceTimingError::MissingCustomerDeadline)
        );
    }

    #[test]
    fn remaining_time_saturates_at_zero() {
        assert_eq!(remaining_ms(Some(9_000), 8_500), Some(500));
        assert_eq!(remaining_ms(Some(9_000), 10_000), Some(0));
        assert_eq!(remaining_ms(None, 10_000), None);
    }
}
