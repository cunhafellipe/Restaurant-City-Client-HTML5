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

### Latest checkpoint — M3 service-loop authority gate 1

- Canonical 0.9.143a service chain is now frozen in
  `contracts/restaurant-city/recovered-service-loop.json`:
  customer admission/seating → `DishOrder` → chef → waiter → eat → empty plate.
- Recovered customer timing includes **1 s** post-seat decision, **10 s** order
  wait, **120 s** food wait, **25 s** eating and **2 s** paying.
- Recovered chef base cook time is **16–32 s**, linearly interpolated by
  employee work percentage between 20% and 80%; waiter action delay is
  **2–6 s**.
- Customer cadence is source-grounded:
  `60000 / (min(demand, 550) * 0.05) + rnd(-3000, 3000)`.
- TypeScript and Rust now carry matching deterministic customer/order state
  machines. Random/path choices are explicit inputs rather than hidden browser
  authority.
- Historical payout boundary is preserved exactly: **finishing a meal does not
  pay**. `clearEmptyPlate(order)` is the settlement trigger.
- Meal settlement is one atomic, idempotent Rust mutation:
  `recipe.cost` coins plus gourmet points stored in historical tenths
  (`10 + 2 * (recipe.level - 1)`). The browser has no reward-grant endpoint.
- Product gate **35427154909** is GREEN on physical runner
  `ANEWON-REVIVAL-01`: **97/97 TypeScript**, **83/83 Rust**, catalog remains
  **92**, item→atlas remains **92 unique / 0 ambiguous / 0 missing**, and every
  existing browser golden stayed frozen.
- Artifact `10579641712`, SHA-256
  `2c9b2670a891d8110cad053b88cf424ebe5755b3ddfa103b600837a3913a3243`.
- Validated behavioral product SHA:
  `fe3ce19c92ece6110b3da7327238de4a5cb6f4df`.

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
| 2026-09-19 | M3 service-loop authority gate 1 closed: canonical admission/order/chef/waiter/eat/plate-clear contract, deterministic TS/Rust replay, atomic idempotent payout, 97 TS + 83 Rust green in run 35427154909. |
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

1. recover and pin service-topology rules as a native contract:
   chair-facing tile, table eligibility and waiter → kitchen → chair reachability;
2. project authoritative placed chair/table/kitchen items into a gameplay
   topology snapshot without duplicating editor ownership;
3. implement the first live Phaser actor fixture using the deterministic M3
   reducer while keeping reward settlement server-only;
4. persist active service-loop state/replay identity before exposing any
   network mutation that could award a meal;
5. add physical browser evidence for one complete customer meal lifecycle,
   then freeze it before expanding to drinks/toilet/cleaner branches.
