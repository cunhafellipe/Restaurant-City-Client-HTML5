use std::fmt;

/// Opaque stable player subject obtained from an already-verified ANEWON
/// Platform session.
///
/// Restaurant City does not interpret provider IDs, email addresses or OAuth
/// subjects as canonical identity.
#[derive(Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct AnewSubject(String);

impl AnewSubject {
    /// Construct only at the trusted Platform adapter boundary after session
    /// verification. This performs shape hygiene, not authentication.
    pub fn from_verified_platform_subject(value: String) -> Result<Self, PlatformSessionError> {
        if value.is_empty() || value.len() > 256 || value.chars().any(char::is_whitespace) {
            return Err(PlatformSessionError::InvalidSubject);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for AnewSubject {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("AnewSubject").field(&"<opaque>").finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedProductSession {
    pub subject: AnewSubject,
    pub session_id: String,
}

/// Product-facing port for the ANEWON Platform session boundary.
///
/// Concrete HTTP/service composition belongs at the application edge. The
/// product domain never verifies Google/Apple/Facebook/Discord/etc. tokens.
pub trait PlatformSessionVerifier {
    fn verify_product_session(
        &self,
        bearer_token: &str,
    ) -> Result<VerifiedProductSession, PlatformSessionError>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlatformSessionError {
    Missing,
    Invalid,
    Expired,
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
    fn opaque_subject_debug_does_not_leak_value() {
        let subject =
            AnewSubject::from_verified_platform_subject("anew_0123456789".to_owned()).unwrap();
        let debug = format!("{subject:?}");

        assert!(!debug.contains("0123456789"));
        assert!(debug.contains("<opaque>"));
    }

    #[test]
    fn malformed_subject_is_rejected_at_adapter_boundary() {
        assert_eq!(
            AnewSubject::from_verified_platform_subject(String::new()),
            Err(PlatformSessionError::InvalidSubject)
        );
        assert_eq!(
            AnewSubject::from_verified_platform_subject("provider user".to_owned()),
            Err(PlatformSessionError::InvalidSubject)
        );
    }
}
