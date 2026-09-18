# ANEWON Restaurant City — revival product

Restaurant City is being rebuilt as an **ANEWON Product** using the
`SOCIAL_WEB` execution/security profile.

The recovered Restaurant City 0.9.143a corpus and community revival projects
are compatibility, preservation and behavioral references. They are **not**
the ANEWON identity, security or release architecture.

## Product boundary

This repository currently incubates the ANEWON-native product implementation:

- TypeScript/Phaser browser client;
- Restaurant City gameplay/domain code;
- title-specific compatibility adapters;
- product-authoritative game-state backend;
- product-local build and parity tooling.

Shared company capabilities stay outside the product:

- `anew-platform`: ANEWON identity/session/social/entitlements/shared business capabilities;
- `anew-runtime`: Asset Vault interfaces, AnewPack, signed manifests,
  key envelopes, protected-client artifact gates and reusable runtime security;
- `anew-docs`: architecture, security, IP policy and ADR authority.

See `docs/13-anewon-product-architecture.md`.

## Historical/golden references

| Lineage | Role |
|---|---|
| recovered 0.9.143a archive | frozen historical compatibility/content baseline |
| n3r0 RestaurantCity_SWF | raw mirror/decompile anchor |
| Dippys AS3/client | behavioral/rebuild reference |
| Dippys server | compatibility and legacy RPC golden harness |
| Dippys HTML5 work | native-web prior art / migration baseline |

The ANEWON implementation may reproduce compatible behavior, but production
authority must not depend on legacy Facebook/Discord/provider identity logic
from those references.

## Asset and rights boundary

Historical Restaurant City material is `LEGACY_RESEARCH` unless and until an
explicit rights basis allows a different classification.

Original/historical bytes remain in the private research/Asset Vault boundary.
Git contains code, hashes, manifests, provenance, metadata, tests and build
recipes. Generated runtime derivatives are not automatically releaseable merely
because they can be technically produced.

The frozen baseline archive is identified by SHA-256:

`4493be9bc4c2f87ef80ca7afa5321e12bb94a7ec6ed2f0a673b4d48b19170ef4`

## Security model

The browser is hostile. Currency, inventory, recipes, rewards, purchases,
timers, progression and challenge completion are authoritative on the product
backend. Client rendering/prediction never grants authority.

A protected production release must use the existing ANEWON protected
`SOCIAL_WEB` foundation: purpose-built runtime derivatives, signed manifests,
authenticated AnewPack ciphertext, short-lived Platform-authorized key
envelopes and the client-artifact extraction gate.

## Current implementation state

M0 of the inherited HTML5 work established the asset-pipeline proof. ANEWON is
now completing M1 while introducing the permanent product boundaries rather
than building further on legacy infrastructure assumptions.

Implemented on `anewon/revival-content`:

- deterministic historical content layers;
- frozen 0.9.143a baseline layer;
- full visual-SWF pipeline target set;
- local-only historical BIN/XML decoder and inventory;
- ANEWON architecture/security documentation;
- product-authority foundation in progress.

Live engineering state: `docs/status.md`.

## Local commands

```bash
npm ci
npm run check
npm test
npm run build
npm run pipeline
npm run content:extract
```

The legacy Dippys backend may be run as a **compatibility harness** while
porting/parity-testing the historical RPC behavior. New production account,
session, social and protected-content authorization must use ANEWON boundaries
instead of extending that legacy identity stack.

## Documentation authority

For cross-product/security work, read these first:

- `anewonhq/anew-docs/ARCHITECTURE.md`
- `anewonhq/anew-docs/SECURITY.md`
- `anewonhq/anew-docs/IP-ASSET-POLICY.md`
- `anewonhq/anew-docs/PRODUCT-SECURITY-PROFILES.md`
- `anewonhq/anew-docs/THREAT-MODEL-SOCIAL-WEB.md`
- ADR-0004, ADR-0005, ADR-0008 and Restaurant City ADR-0009
