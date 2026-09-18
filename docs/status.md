# Status — ANEWON Restaurant City revival

Living tracker. Facts only; update when implementation evidence changes.

## Current

- Product: **ANEWON Restaurant City**
- Lifecycle: **incubation**
- Execution/security profile: **SOCIAL_WEB**
- Phase: **M1 — full historical baseline ingestion + permanent ANEWON boundaries**
- Architecture authority: `anewonhq/anew-docs` ADR-0009
- Implementation branch: `anewon/revival-content`

## Current objective

Complete a deterministic, locally generated representation of every usable
0.9.143a visual/data resource while building the product on permanent ANEWON
Platform/Runtime boundaries.

The legacy client/server remain golden compatibility harnesses. They are not
the production identity/security root.

## Verified foundation

| Area | State | Evidence |
|---|---|---|
| M0 ingredient visual pipeline | done | 92/92 symbols, 161 frames |
| canonical beta provenance | done | recovered 0.9.143a SHA-256 `4493be9b...`; 24/24 content-equivalent to pinned n3r0 |
| historical content layers | done | `src/content/catalog.ts` + tests |
| ANEWON product routing | done | ADR-0009 merged in `anew-docs` |
| product security policy | done | `SECURITY.md` + `anewon.product.json` |
| production source maps | disabled | `vite.config.ts` |
| product-authority domain | active | `server/`: opaque Platform subject, checked/idempotent economy/inventory mutations |
| full visual corpus pipeline | active | bounded deterministic multi-atlas pages; R16.x runner verification |
| BIN/XML local decoder | active | `tools/extract-content.mjs`; decoded output stays gitignored/local |
| later historical bytes | unresolved | R15/R17 exhausted current automated host/Wayback routes with 0 accepted bytes |

## Historical research boundary

`RestaurantCity_201401` is **REJECTED/OWNER-IRRELEVANT** and must not be
requeued.

The 2012 2.20.3 / 2.21.2 / challenges.bin targets remain high-value evidence
targets, but no later-version bytes are promoted until actually recovered,
hashed, classified and semantically diffed.

## M1 acceptance

- [ ] all 7 visual asset SWFs at 100% linked-symbol coverage using bounded pages;
- [ ] sound asset extracted into web-runtime audio derivatives;
- [ ] all canonical data files decoded and mapped into typed product data;
- [ ] deterministic manifest regenerates identically;
- [ ] generated development assets stay outside Git;
- [ ] rights/exposure/release metadata is preserved through the content build;
- [ ] client TypeScript checks/tests/build green;
- [ ] product-authority Rust fmt/clippy/tests green.

## M2 entry gate

M2 starts when the product can load a validated content manifest and an
ANEWON-authenticated player state through explicit ports. The legacy binary
RPC may be used for parity/replay, but must not become the native domain API.

## Session log

| Date | What |
|---|---|
| 2026-09-18 | ADR-0009 merged: Restaurant City formally routed as ANEWON SOCIAL_WEB Product; Platform/Runtime/product boundaries fixed. |
| 2026-09-18 | Product authority Rust foundation added with opaque ANEWON subject and idempotent checked state mutations. |
| 2026-09-18 | Visual pipeline upgraded from one unbounded PNG to deterministic bounded multi-atlas pages for the full corpus. |
| 2026-09-18 | Local-only BIN/XML decoder added; original historical bytes remain in Vault/research boundary. |
| 2026-07-31 | M0 closed: ingredient pipeline 92/92 symbols, 161 frames; BootScene/proxy proof and original tests green. |

## Blockers

- full R16 corpus run must finish cleanly and provide final visual/data counts;
- later 2010-2012 assets/data remain historically evidenced but byte recovery
  is unresolved;
- public/commercial distribution of legacy assets remains blocked absent an
  explicit rights basis.

## Next

1. close R16 full-corpus extraction and freeze counts/hashes;
2. build typed data tables from the decoded canonical XML;
3. extract sound assets;
4. introduce native product state/load boundary while retaining legacy RPC
   replay tests;
5. implement M2 world/editor vertical slice against the authoritative domain;
6. continue later-version recovery only through new evidence pivots, not blind
   reruns of exhausted R15/R17 routes.
