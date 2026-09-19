use crate::platform::AnewSubject;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Wallet {
    coins: u64,
    cash: u64,
    gourmet_points: u64,
}

impl Wallet {
    pub fn coins(&self) -> u64 {
        self.coins
    }

    pub fn cash(&self) -> u64 {
        self.cash
    }

    /// Raw historical storage units. Restaurant City stores one displayed
    /// gourmet point as ten integer units.
    pub fn gourmet_points(&self) -> u64 {
        self.gourmet_points
    }

    pub fn gourmet_point_tenths(&self) -> u64 {
        self.gourmet_points
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Inventory {
    quantities: BTreeMap<u32, u32>,
}

impl Inventory {
    pub fn quantity(&self, item_id: u32) -> u32 {
        self.quantities.get(&item_id).copied().unwrap_or(0)
    }

    pub fn entries(&self) -> impl Iterator<Item = (u32, u32)> + '_ {
        self.quantities
            .iter()
            .map(|(item_id, quantity)| (*item_id, *quantity))
    }
}

#[derive(Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct MutationId(String);

impl MutationId {
    pub fn new(value: String) -> Result<Self, AuthorityError> {
        if value.is_empty() || value.len() > 128 || value.chars().any(char::is_whitespace) {
            return Err(AuthorityError::InvalidMutationId);
        }
        Ok(Self(value))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for MutationId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("MutationId").field(&"<opaque>").finish()
    }
}

/// Low-level authoritative mutations.
///
/// Amounts and rewards are supplied by verified product gameplay logic whose
/// values come from validated Restaurant City data/rules. This layer never
/// invents balance constants.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Command {
    CreditCoins {
        amount: u64,
    },
    DebitCoins {
        amount: u64,
    },
    CreditCash {
        amount: u64,
    },
    DebitCash {
        amount: u64,
    },
    AwardGourmetPoints {
        amount: u64,
    },
    /// Atomically settle one verified meal. Gourmet points use the historical
    /// raw storage unit of tenths (GameWorld.addGourmetPoints multiplies by 10).
    SettleMeal {
        coins: u64,
        gourmet_point_tenths: u64,
    },
    GrantInventory {
        item_id: u32,
        quantity: u32,
    },
    ConsumeInventory {
        item_id: u32,
        quantity: u32,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MutationOutcome {
    Applied { revision: u64 },
    Duplicate { revision: u64 },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub(crate) struct PlayerPersistenceSnapshot {
    pub subject: [u8; 16],
    pub revision: u64,
    pub coins: u64,
    pub cash: u64,
    pub gourmet_points: u64,
    pub inventory: Vec<(u32, u32)>,
    pub processed_mutations: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlayerState {
    subject: AnewSubject,
    revision: u64,
    wallet: Wallet,
    inventory: Inventory,
    processed_mutations: BTreeSet<MutationId>,
}

impl PlayerState {
    pub fn new(subject: AnewSubject) -> Self {
        Self {
            subject,
            revision: 0,
            wallet: Wallet::default(),
            inventory: Inventory::default(),
            processed_mutations: BTreeSet::new(),
        }
    }

    pub fn subject(&self) -> &AnewSubject {
        &self.subject
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn wallet(&self) -> &Wallet {
        &self.wallet
    }

    pub fn inventory(&self) -> &Inventory {
        &self.inventory
    }

    pub(crate) fn persistence_snapshot(&self) -> PlayerPersistenceSnapshot {
        PlayerPersistenceSnapshot {
            subject: *self.subject.as_bytes(),
            revision: self.revision,
            coins: self.wallet.coins,
            cash: self.wallet.cash,
            gourmet_points: self.wallet.gourmet_points,
            inventory: self
                .inventory
                .quantities
                .iter()
                .map(|(item_id, quantity)| (*item_id, *quantity))
                .collect(),
            processed_mutations: self
                .processed_mutations
                .iter()
                .map(|mutation| mutation.as_str().to_owned())
                .collect(),
        }
    }

    pub(crate) fn from_persistence_snapshot(
        snapshot: PlayerPersistenceSnapshot,
    ) -> Result<Self, AuthorityError> {
        let subject = AnewSubject::from_verified_platform_bytes(snapshot.subject)
            .map_err(|_| AuthorityError::CorruptSnapshot)?;

        let mut quantities = BTreeMap::new();
        for (item_id, quantity) in snapshot.inventory {
            if quantity == 0 || quantities.insert(item_id, quantity).is_some() {
                return Err(AuthorityError::CorruptSnapshot);
            }
        }

        let mut processed_mutations = BTreeSet::new();
        for value in snapshot.processed_mutations {
            let mutation = MutationId::new(value).map_err(|_| AuthorityError::CorruptSnapshot)?;
            if !processed_mutations.insert(mutation) {
                return Err(AuthorityError::CorruptSnapshot);
            }
        }

        let mutation_count = u64::try_from(processed_mutations.len())
            .map_err(|_| AuthorityError::CorruptSnapshot)?;
        if mutation_count != snapshot.revision {
            return Err(AuthorityError::CorruptSnapshot);
        }

        Ok(Self {
            subject,
            revision: snapshot.revision,
            wallet: Wallet {
                coins: snapshot.coins,
                cash: snapshot.cash,
                gourmet_points: snapshot.gourmet_points,
            },
            inventory: Inventory { quantities },
            processed_mutations,
        })
    }

    /// Apply an authoritative mutation exactly once.
    ///
    /// A duplicate mutation is a successful no-op. Validation completes
    /// before state is changed, so rejected commands cannot partially mutate
    /// the in-memory state.
    pub fn apply(
        &mut self,
        mutation_id: MutationId,
        command: Command,
    ) -> Result<MutationOutcome, AuthorityError> {
        if self.processed_mutations.contains(&mutation_id) {
            return Ok(MutationOutcome::Duplicate {
                revision: self.revision,
            });
        }

        let next_revision = self
            .revision
            .checked_add(1)
            .ok_or(AuthorityError::ArithmeticOverflow)?;

        let validated = self.validate(&command)?;
        self.commit(validated);

        self.processed_mutations.insert(mutation_id);
        self.revision = next_revision;

        Ok(MutationOutcome::Applied {
            revision: self.revision,
        })
    }

    fn validate(&self, command: &Command) -> Result<ValidatedCommand, AuthorityError> {
        match *command {
            Command::CreditCoins { amount } => Ok(ValidatedCommand::Coins(
                self.wallet
                    .coins
                    .checked_add(amount)
                    .ok_or(AuthorityError::ArithmeticOverflow)?,
            )),
            Command::DebitCoins { amount } => Ok(ValidatedCommand::Coins(
                self.wallet
                    .coins
                    .checked_sub(amount)
                    .ok_or(AuthorityError::InsufficientCoins)?,
            )),
            Command::CreditCash { amount } => Ok(ValidatedCommand::Cash(
                self.wallet
                    .cash
                    .checked_add(amount)
                    .ok_or(AuthorityError::ArithmeticOverflow)?,
            )),
            Command::DebitCash { amount } => Ok(ValidatedCommand::Cash(
                self.wallet
                    .cash
                    .checked_sub(amount)
                    .ok_or(AuthorityError::InsufficientCash)?,
            )),
            Command::AwardGourmetPoints { amount } => Ok(ValidatedCommand::GourmetPoints(
                self.wallet
                    .gourmet_points
                    .checked_add(amount)
                    .ok_or(AuthorityError::ArithmeticOverflow)?,
            )),
            Command::SettleMeal {
                coins,
                gourmet_point_tenths,
            } => {
                let coins = self
                    .wallet
                    .coins
                    .checked_add(coins)
                    .ok_or(AuthorityError::ArithmeticOverflow)?;
                let gourmet_points = self
                    .wallet
                    .gourmet_points
                    .checked_add(gourmet_point_tenths)
                    .ok_or(AuthorityError::ArithmeticOverflow)?;
                Ok(ValidatedCommand::Meal {
                    coins,
                    gourmet_points,
                })
            }
            Command::GrantInventory { item_id, quantity } => {
                require_quantity(quantity)?;
                let value = self
                    .inventory
                    .quantity(item_id)
                    .checked_add(quantity)
                    .ok_or(AuthorityError::ArithmeticOverflow)?;
                Ok(ValidatedCommand::Inventory { item_id, value })
            }
            Command::ConsumeInventory { item_id, quantity } => {
                require_quantity(quantity)?;
                let current = self.inventory.quantity(item_id);
                let value =
                    current
                        .checked_sub(quantity)
                        .ok_or(AuthorityError::InsufficientInventory {
                            item_id,
                            available: current,
                            requested: quantity,
                        })?;
                Ok(ValidatedCommand::Inventory { item_id, value })
            }
        }
    }

    fn commit(&mut self, command: ValidatedCommand) {
        match command {
            ValidatedCommand::Coins(value) => self.wallet.coins = value,
            ValidatedCommand::Cash(value) => self.wallet.cash = value,
            ValidatedCommand::GourmetPoints(value) => self.wallet.gourmet_points = value,
            ValidatedCommand::Meal {
                coins,
                gourmet_points,
            } => {
                self.wallet.coins = coins;
                self.wallet.gourmet_points = gourmet_points;
            }
            ValidatedCommand::Inventory { item_id, value } => {
                if value == 0 {
                    self.inventory.quantities.remove(&item_id);
                } else {
                    self.inventory.quantities.insert(item_id, value);
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ValidatedCommand {
    Coins(u64),
    Cash(u64),
    GourmetPoints(u64),
    Meal { coins: u64, gourmet_points: u64 },
    Inventory { item_id: u32, value: u32 },
}

fn require_quantity(quantity: u32) -> Result<(), AuthorityError> {
    if quantity == 0 {
        Err(AuthorityError::InvalidQuantity)
    } else {
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuthorityError {
    CorruptSnapshot,
    InvalidMutationId,
    InvalidQuantity,
    ArithmeticOverflow,
    InsufficientCoins,
    InsufficientCash,
    InsufficientInventory {
        item_id: u32,
        available: u32,
        requested: u32,
    },
}

impl fmt::Display for AuthorityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for AuthorityError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::AnewSubject;

    fn player() -> PlayerState {
        PlayerState::new(AnewSubject::from_verified_platform_bytes([1; 16]).unwrap())
    }

    fn id(value: &str) -> MutationId {
        MutationId::new(value.to_owned()).unwrap()
    }

    #[test]
    fn persistence_snapshot_round_trip_preserves_authoritative_state() {
        let mut state = player();
        state
            .apply(id("coins-1"), Command::CreditCoins { amount: 25 })
            .unwrap();
        state
            .apply(
                id("inventory-1"),
                Command::GrantInventory {
                    item_id: 42,
                    quantity: 3,
                },
            )
            .unwrap();

        let restored =
            PlayerState::from_persistence_snapshot(state.persistence_snapshot()).unwrap();
        assert_eq!(restored, state);
    }

    #[test]
    fn corrupt_persistence_snapshot_is_rejected() {
        let mut snapshot = player().persistence_snapshot();
        snapshot.revision = 1;

        assert_eq!(
            PlayerState::from_persistence_snapshot(snapshot),
            Err(AuthorityError::CorruptSnapshot)
        );
    }

    #[test]
    fn duplicate_mutation_is_idempotent() {
        let mut state = player();

        assert_eq!(
            state
                .apply(id("m-1"), Command::CreditCoins { amount: 50 })
                .unwrap(),
            MutationOutcome::Applied { revision: 1 }
        );
        assert_eq!(
            state
                .apply(id("m-1"), Command::CreditCoins { amount: 50 })
                .unwrap(),
            MutationOutcome::Duplicate { revision: 1 }
        );
        assert_eq!(state.wallet().coins(), 50);
    }

    #[test]
    fn rejected_debit_does_not_mutate_or_consume_mutation_id() {
        let mut state = player();

        assert_eq!(
            state.apply(id("purchase-1"), Command::DebitCoins { amount: 1 }),
            Err(AuthorityError::InsufficientCoins)
        );
        assert_eq!(state.revision(), 0);

        state
            .apply(id("seed"), Command::CreditCoins { amount: 10 })
            .unwrap();
        assert_eq!(
            state
                .apply(id("purchase-1"), Command::DebitCoins { amount: 1 })
                .unwrap(),
            MutationOutcome::Applied { revision: 2 }
        );
        assert_eq!(state.wallet().coins(), 9);
    }

    #[test]
    fn inventory_never_underflows() {
        let mut state = player();
        state
            .apply(
                id("grant-1"),
                Command::GrantInventory {
                    item_id: 42,
                    quantity: 2,
                },
            )
            .unwrap();

        assert_eq!(
            state.apply(
                id("consume-1"),
                Command::ConsumeInventory {
                    item_id: 42,
                    quantity: 3,
                },
            ),
            Err(AuthorityError::InsufficientInventory {
                item_id: 42,
                available: 2,
                requested: 3,
            })
        );
        assert_eq!(state.inventory().quantity(42), 2);
    }

    #[test]
    fn zero_quantity_is_rejected_before_mutation() {
        let mut state = player();

        assert_eq!(
            state.apply(
                id("grant-zero"),
                Command::GrantInventory {
                    item_id: 7,
                    quantity: 0,
                },
            ),
            Err(AuthorityError::InvalidQuantity)
        );
        assert_eq!(state.revision(), 0);
    }
    #[test]
    fn meal_settlement_is_atomic_and_idempotent() {
        let mut state = player();

        assert_eq!(
            state
                .apply(
                    id("meal-1"),
                    Command::SettleMeal {
                        coins: 25,
                        gourmet_point_tenths: 12,
                    },
                )
                .unwrap(),
            MutationOutcome::Applied { revision: 1 }
        );
        assert_eq!(state.wallet().coins(), 25);
        assert_eq!(state.wallet().gourmet_point_tenths(), 12);

        assert_eq!(
            state
                .apply(
                    id("meal-1"),
                    Command::SettleMeal {
                        coins: 25,
                        gourmet_point_tenths: 12,
                    },
                )
                .unwrap(),
            MutationOutcome::Duplicate { revision: 1 }
        );
        assert_eq!(state.wallet().coins(), 25);
        assert_eq!(state.wallet().gourmet_point_tenths(), 12);
    }

    #[test]
    fn meal_settlement_validates_both_balances_before_committing_either() {
        let mut state = player();
        state
            .apply(
                id("gp-max"),
                Command::AwardGourmetPoints { amount: u64::MAX },
            )
            .unwrap();

        assert_eq!(
            state.apply(
                id("meal-overflow"),
                Command::SettleMeal {
                    coins: 50,
                    gourmet_point_tenths: 1,
                },
            ),
            Err(AuthorityError::ArithmeticOverflow)
        );
        assert_eq!(state.revision(), 1);
        assert_eq!(state.wallet().coins(), 0);
        assert_eq!(state.wallet().gourmet_point_tenths(), u64::MAX);
    }
}
