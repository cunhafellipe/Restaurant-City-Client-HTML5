# Status — ANEWON Restaurant City revival

Living tracker. Facts only; update when implementation evidence changes.

## Current

- Product: **ANEWON Restaurant City**
- Lifecycle: **incubation**
- Execution/security profile: **SOCIAL_WEB**
- Phase: **M3 — first historically grounded restaurant gameplay loop**
- Architecture authority: `anewonhq/anew-docs` ADR-0009
- Implementation branch: `anewon/revival-content`

## Current objective

M2 world/editor parity is closed. Begin the first actual restaurant gameplay
vertical slice from canonical `WorldRestaurantPlay`: customer admission/seating,
`DishOrder`, chef cooking, waiter delivery, eating/empty-plate cleanup and the
authoritative meal payout boundary.

### Latest checkpoint — canonical wallDivider closure / M2

- Canonical `wallDivider` inventory is exactly **5 items**:
  `3020049..3020052` and `3020055`.
- R36 proves **0/5 are wallItem**; they are ordinary `decorItem,wallDivider`
  objects and therefore do not mutate `wallMap`/`wallItems`.
- R37: **5/5 constructor geometries** recovered; all 1×1, no subItems.
- R38: **12/12 atlas frame origins** recovered.
- Physical 12-frame Edge golden: block
  `34a15ba2363b951f7a4edc026e7653f8b6ccde761e8e15f6af8133fdf8b78e73`.
- Trusted placement catalog: **92 definitions**.
- Item → atlas authority mapping: **92 unique / 0 ambiguous / 0 missing**.
- Browser E2E: White Wall place → select → rotate → move → remove.
- Product gate **35426235929** is GREEN: **90/90 TypeScript**, **75/75 Rust**,
  all prior Cannon/Floor/Window/Stack/Door/Wallpaper goldens unchanged.
- Artifact `10579275728`, SHA-256
  `a0b9ff6702f31a231e8432df0c50d7ab37533e671ee28d3014a05b7fc11d2bbb`.

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
| 2026-09-19 | M2 world/editor slice closed: R36 identified 5 canonical wallDividers as ordinary decor (0 wallItem), R37/R38 recovered 5/5 geometry + 12/12 origins, 92/92 trusted mapping and White Wall browser lifecycle green in run 35426235929. |
| 2026-09-19 | Wallpaper domain closed as playable vertical slice: R34 48/48 exports + R35 96/96 frame origins, V4 authority/persistence, 87/87 trusted item-atlas mapping, frozen left/top browser goldens, and real Edge apply/select/remove flow green in run 35424279934. |
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
