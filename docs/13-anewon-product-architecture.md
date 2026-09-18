# 13 — ANEWON product architecture

## Decision

Restaurant City is an ANEWON **Product**, profile `SOCIAL_WEB`.

The architecture deliberately separates four concerns:

```text
ANEWON Platform
 identity / account / session / social / entitlement
              |
              | authenticated product subject/session
              v
Restaurant City product backend
 authoritative gameplay/economy/state
              |
              | validated state/events/content eligibility
              v
Restaurant City browser client
 Phaser renderer + deterministic simulation/prediction
              |
              | protected content contract
              v
ANEWON Runtime
 AnewPack / signed manifest / key envelope / asset gates
```

The Dippys/Flash server and protocol sit beside this path as a **golden
compatibility harness**, not underneath it as a production trust dependency.

## Repository responsibility

Product-owned:

- Restaurant/floor state and placement.
- Items, recipes, ingredients and dish progression.
- Customers, employees and simulation rules.
- Economy and product progression.
- Garden, quiz, challenges, tutorials and events.
- Product social behaviors after Platform identity/privacy authorization.
- Legacy Playfish compatibility adapters.
- Product persistence and authoritative action validation.
- DOM/CSS product UI/HUD and product-specific content mapping.
- Phaser world rendering, simulation presentation and world-space interaction.

Not product-owned:

- passwords or provider OAuth custody;
- canonical cross-game identity;
- global ANEWON social graph;
- AnewPack cryptography;
- key-envelope cryptography;
- global Asset Vault implementation;
- release signing root;
- shared infrastructure/provider SDKs.

## Identity contract

The game consumes an opaque authenticated ANEWON subject. It does not infer an
account from email, Facebook ID, Discord ID or any other provider identity.

Provider linking/recovery remains a Platform security event. Product state
references the stable ANEWON subject only.

## Authoritative state

The server validates and commits every security-sensitive mutation. The client
may render optimistically but cannot mint value.

Minimum authoritative domains:

- wallet/currency;
- inventory/owned items;
- ingredients/recipes;
- purchases and sale proceeds;
- rewards/drops/daily bonus;
- XP/gourmet progression;
- timers and harvest/cooking completion;
- employee state that has economy impact;
- challenge/quiz completion and rewards;
- mail/trade/gifts where value moves.

Mutation APIs require idempotency/replay protection appropriate to the action.

## Compatibility boundary

The historical binary RPC codec and the Dippys server remain useful because
they provide byte-level behavior and replay fixtures.

The migration pattern is:

```text
historical client/protocol
        |
        v
compat adapter / golden tests
        |
        +---- compare ----> ANEWON native product behavior
                               |
                               v
                         authoritative domain
```

Do not let the compatibility transport leak into core game rules. Core systems
operate on typed product commands/state.

## Asset path

Research originals:

```text
ANEWON research/Vault
  LEGACY_RESEARCH originals
       |
       | tool-time decode/extract; provenance preserved
       v
approved derivative build input
       |
       | only after rights/exposure/release gates
       v
ANEWON Runtime release pipeline
  runtime derivative -> AnewPack -> signed manifest
       |
       v
CDN ciphertext + Platform key authorization
       |
       v
browser Worker/runtime -> memory-only plaintext -> renderer
```

The current local extraction tools deliberately write decoded XML and generated
atlases only to gitignored/local workspaces.

## Content lineage

The 0.9.143a corpus is the immutable compatibility baseline. Later historical
families are overlays, never anonymous replacements.

A later layer is eligible only after byte recovery, provenance/hash recording,
semantic comparison and asset-policy classification.

Evidence such as a forum post or version number without recovered bytes remains
`reference-only` and cannot affect runtime content.

## Build/release rules

Development may use readable local derivatives and compatibility servers.

Protected production is different:

- no production source maps;
- dedicated protected origin;
- no unrelated third-party scripts;
- strict CSP/Trusted Types/integrity as applicable;
- master/source assets absent;
- unreleased/server-only assets absent;
- encrypted AnewPack runtime derivatives only when classified protected;
- signed exact-byte manifests;
- short-lived context-bound key envelopes;
- static extraction/adversarial gate before release.

## Technology choices

- Browser client: TypeScript + HTML/CSS DOM shell + Phaser world renderer, with a deterministic framework-free core.
- Historical SWF/BIN are trusted-pipeline research/build inputs only; production browser runtime never executes or parses them.
- Tooling: Node.js for deterministic extraction/conversion where it is already
  effective; FFDec is a build/research dependency, not a runtime dependency.
- Product authority: Rust modular backend/domain foundation, unsafe forbidden,
  matching ANEWON engineering/security posture while preserving explicit
  Platform/Runtime boundaries.
- Historical RPC: isolated compatibility adapter; never the domain model.

This is intentionally not microservice-per-system. Split only when measured
security, scaling, ownership or release-cadence evidence justifies it.
