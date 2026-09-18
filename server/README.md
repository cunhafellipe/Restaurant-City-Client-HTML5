# Restaurant City authority

Product-authoritative domain/backend foundation for the ANEWON Restaurant City
revival.

This is **not** a port of provider login code and is not a fork of ANEWON
Platform or Runtime.

## Boundaries

- ANEWON Platform verifies account/session identity and supplies an opaque
  product subject.
- This crate owns Restaurant City state transitions and product invariants.
- ANEWON Runtime owns protected asset/release cryptography.
- Legacy Playfish/Dippys RPC is a compatibility adapter/golden test input.

The first slice intentionally contains no HTTP framework or database. It makes
the trust boundary testable before transport/persistence choices are attached.

## Gates

```bash
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
```

Unsafe Rust is forbidden.
