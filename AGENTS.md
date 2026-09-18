# AGENTS.md — ANEWON Restaurant City product rules

This repository is the current incubation implementation of the ANEWON
Restaurant City product. Execution profile: `SOCIAL_WEB`.

## Mandatory orientation

Before changing product/runtime/security boundaries, read in order:

1. `README.md` and `docs/status.md`;
2. `docs/13-anewon-product-architecture.md`;
3. `anewonhq/anew-docs/REPOSITORY-CATALOG.md`;
4. `anewonhq/anew-docs/ARCHITECTURE.md`;
5. `anewonhq/anew-docs/SECURITY.md`;
6. `anewonhq/anew-docs/IP-ASSET-POLICY.md`;
7. `anewonhq/anew-docs/THREAT-MODEL-SOCIAL-WEB.md`;
8. ADR-0004, ADR-0005, ADR-0008 and Restaurant City ADR-0009.

For gameplay/parity work also read `docs/03-game-systems.md`,
`docs/05-network-protocol.md`, `docs/08-roadmap.md` and the cited AS3
reference classes.

## Source-of-truth order

For this product:

1. ANEWON security/IP policy and accepted ADRs;
2. ANEWON product architecture;
3. recovered original Restaurant City behavior/data;
4. n3r0/Dippys compatibility and golden evidence;
5. current implementation.

A legacy implementation never overrides ANEWON security boundaries.

## Repository map

| Path | Responsibility |
|---|---|
| `src/core` | deterministic product state/rules; no Phaser/DOM |
| `src/systems` | deterministic gameplay systems |
| `src/game` | Phaser rendering/input/scenes |
| `src/ui` | product UI/HUD |
| `src/net` | browser transport and compatibility adapters |
| `src/content` | validated content-layer metadata/resolution |
| `src/anewon` | thin product-facing Platform/Runtime ports only |
| `server/` | product-authoritative game domain/backend |
| `tools/` | local extraction/build/parity tools |
| `tools/.work` | local-only decoded historical/build material |
| `public/assets/generated` | generated dev derivatives; gitignored |
| `docs/` | product design/status/decisions |

## Hard boundaries

1. **Browser is hostile.** Never authorize currency, inventory, rewards,
   purchases, progression, timers or valuable ownership in client code.
2. **Platform owns identity.** Do not add provider passwords/tokens/OAuth
   custody or email-based account merging here. Consume opaque ANEWON subject
   and session contracts through adapters.
3. **Runtime owns protected-content primitives.** Do not fork AnewPack,
   manifest signing, key-envelope crypto or company artifact gates.
4. **Historical assets are LEGACY_RESEARCH.** Original bytes stay outside
   normal Git. Do not publish them through CI artifacts.
5. **No release by inference.** A recovered/downloadable asset is not
   automatically approved for public/commercial use.
6. **No protected production source maps.**
7. **Legacy RPC is compatibility, not domain architecture.** Keep codecs and
   golden replay adapters outside core gameplay rules.
8. **AS3/data is the gameplay spec.** Do not invent balance constants.
9. **Generated content is never hand-edited.** Fix the extractor/converter.
10. **Determinism:** no ambient clock/randomness in core/systems. Inject time
    and seeded RNG where required.
11. **Done means verified:** relevant TypeScript/Rust checks, tests and build
    must pass; status/checkpoint must reflect real evidence.

## Verification

Client:

```bash
npm ci
npm run check
npm test
npm run build
```

Product authority:

```bash
cd server
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
```

Asset extraction is local/research-only unless a release classification says
otherwise.
