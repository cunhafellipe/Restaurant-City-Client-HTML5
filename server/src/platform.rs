use std::fmt;

pub const PRODUCT_ID: &str = "restaurant-city";
const OPAQUE_ID_BYTES: usize = 16;

/// Exact product-side representation of the canonical ANEWON opaque user id.
///
/// Authentication and account ownership remain in ANEWON Platform. The
/// product receives these bytes only after a Platform adapter has verified a
/// product-scoped session for PRODUCT_ID.
#[derive(Clone, Copy, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct AnewSubject([u8; OPAQUE_ID_BYTES]);

impl AnewSubject {
    pub fn from_verified_platform_bytes(
        value: [u8; OPAQUE_ID_BYTES],
    ) -> Result<Self, PlatformSessionError> {
        if value == [0; OPAQUE_ID_BYTES] {
            return Err(PlatformSessionError::InvalidSubject);
        }
        Ok(Self(value))
    }

    pub const fn as_bytes(&self) -> &[u8; OPAQUE_ID_BYTES] {
        &self.0
    }
}

impl fmt::Debug for AnewSubject {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AnewSubject(..)")
    }
}

#[derive(Clone, Copy, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct ProductSessionId([u8; OPAQUE_ID_BYTES]);

impl ProductSessionId {
    pub fn from_verified_platform_bytes(
        value: [u8; OPAQUE_ID_BYTES],
    ) -> Result<Self, PlatformSessionError> {
        if value == [0; OPAQUE_ID_BYTES] {
            return Err(PlatformSessionError::InvalidSession);
        }
        Ok(Self(value))
    }

    pub const fn as_bytes(&self) -> &[u8; OPAQUE_ID_BYTES] {
        &self.0
    }
}

impl fmt::Debug for ProductSessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ProductSessionId(..)")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VerifiedProductSession {
    pub subject: AnewSubject,
    pub session_id: ProductSessionId,
}

/// Product-facing port for the ANEWON Platform session boundary.
///
/// The concrete adapter MUST verify a live Platform SessionScope::Product for
/// PRODUCT_ID. It must not accept provider OAuth tokens as product sessions.
pub trait PlatformSessionVerifier {
    fn verify_product_session(
        &self,
        session_token: &str,
    ) -> Result<VerifiedProductSession, PlatformSessionError>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlatformSessionError {
    Missing,
    Invalid,
    InvalidSession,
    Expired,
    WrongProduct,
    InvalidSubject,
    Unavailable,
}

impl fmt::Display for PlatformSessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for PlatformSessionError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opaque_values_do_not_leak_in_debug_output() {
        let subject = AnewSubject::from_verified_platform_bytes([7; 16]).unwrap();
        let session = ProductSessionId::from_verified_platform_bytes([9; 16]).unwrap();

        assert_eq!(format!("{subject:?}"), "AnewSubject(..)");
        assert_eq!(format!("{session:?}"), "ProductSessionId(..)");
    }

    #[test]
    fn zero_identifiers_are_rejected_at_adapter_boundary() {
        assert_eq!(
            AnewSubject::from_verified_platform_bytes([0; 16]),
            Err(PlatformSessionError::InvalidSubject)
        );
        assert_eq!(
            ProductSessionId::from_verified_platform_bytes([0; 16]),
            Err(PlatformSessionError::InvalidSession)
        );
    }
}
