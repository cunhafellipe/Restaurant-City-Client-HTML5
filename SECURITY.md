# Restaurant City product security

This repository **strengthens but never weakens** the company policies in
`anewonhq/anew-docs`.

Normative references:

- `SECURITY.md`
- `PRODUCT-SECURITY-PROFILES.md`
- `THREAT-MODEL-SOCIAL-WEB.md`
- ADR-0004 — shielded SOCIAL_WEB security
- ADR-0005 — shared packs + cohort bootstrap
- ADR-0008 — universal hostile-client asset protection
- ADR-0009 — Restaurant City ANEWON product integration

## Product invariants

1. Treat browser code, memory, storage and network as attacker-controlled.
2. Currency, inventory, rewards, recipes, purchases, timers, progression and
   challenge completion are server-authoritative.
3. Provider identity is never a Restaurant City-owned credential system.
   Authentication/session ownership comes from ANEWON Platform.
4. Do not commit credentials, provider tokens, content keys, signing keys or
   Asset Vault credentials.
5. Historical/original Restaurant City bytes are `LEGACY_RESEARCH`; keep them
   out of normal Git and public CI artifacts.
6. Protected production builds contain only approved runtime derivatives.
7. No protected plaintext is intentionally persisted in browser storage.
8. No reusable content key is embedded in JS/WASM/static manifests.
9. Production source maps for the protected client are forbidden.
10. Do not fork the ANEWON key-envelope/AnewPack cryptography in this product.
11. Future/unreleased content is never pre-shipped merely because encrypted.
12. Any production protected release must pass the ANEWON client artifact gate
    and the SOCIAL_WEB adversarial release tests.

## Compatibility harness

Legacy Playfish RPC and community server implementations are valid test/golden
inputs. They do not define production authentication or authorization.

Compatibility code should live behind explicit adapters so it can be removed
without rewriting gameplay or renderer code.

## Reporting

Do not disclose suspected vulnerabilities with production impact in a public
issue before mitigation. Follow the company security reporting path.
