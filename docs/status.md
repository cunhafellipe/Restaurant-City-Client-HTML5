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

M2 world/editor parity is closed. M3 gate 1 froze the canonical service-loop
state machine and payout boundary. M3 gate 2 is now closed as well: the product
derives native service topology from the same authoritative restaurant layout,
projects it read-only to Phaser, and rejects stale layout/topology pairs.

The next slice is the first live single-customer/single-table/single-chef/
single-waiter lifecycle driven by that topology and the already validated
service reducer. Active service identity/replay must become durable before a
live meal is allowed to reach server-only settlement.

### Latest checkpoint — M3 service-topology authority gate 2

- The trusted placement catalog now contains **103 player definitions** with
  **103 unique / 0 ambiguous / 0 missing** item→atlas mappings.
- All **11 canonical kitchen composites** are promoted from physical R42/R43
  evidence with exact per-rotation occupied cells. Rotations 2/3 preserve
  historical negative offsets rather than rebasing the anchor.
- Stove10 is preserved as **4 logical rotations / 1 visual frame**.
- Stove11 resolves fail-closed through the proven runtime alias
  `Stove11Rotations_485`.
- The Rust topology domain derives default walls, door walkability, authoritative
  item occupancy, chair facing tiles, table eligibility/free state, kitchens,
  drinks and waiter/chef reachability from the existing restaurant snapshot.
- Toilet service reachability remains distinct from meal-seat admission:
  `calculateServableTables` semantics may mark service reachability while
  `is_meal_seat` excludes toilets.
- `GET /api/v1/restaurant/topology` is an authenticated, same-origin,
  **read-only/no-store** route. The topology is derived from the same loaded
  aggregate and carries its source room + placed items.
- The TypeScript authority loads a synchronized
  `RestaurantAuthoritativeSnapshot`; stale layout/topology pairs are retried
  once and then rejected fail-closed.
- Phaser consumes and publishes the synchronized topology without receiving any
  economy authority. Physical browser evidence verifies the topology source,
  occupied table cell and walkability while every frozen M2 visual golden
  remains unchanged.
- Product gate **35450486931** is GREEN on the physical runner:
  **102/102 TypeScript**, **98/98 Rust**, catalog **103**, mapping
  **103 unique / 0 ambiguous / 0 missing**, WEB-NATIVE PASS, cargo
  fmt/clippy/test PASS and **0 production npm vulnerabilities**.
- Artifact `10587180002`, SHA-256
  `9745e31358f95e210381813721d066cf358eea1f56b6d18db6969b23b4612eba`.
- Validated behavioral product SHA:
  `20002a82737958e894d511e38a0363fb3357bb97`.

### M3 service-loop authority gate 1

The gate-1 contract remains frozen in
`contracts/restaurant-city/recovered-service-loop.json`:

- canonical customer/order/chef/waiter state transitions and timers;
- chef **16–32 s** work interpolation and waiter **2–6 s** action delay;
- admission cadence
  `60000 / (min(demand, 550) * 0.05) + rnd(-3000, 3000)`;
- payout only at `clearEmptyPlate(order)`;
- atomic/idempotent server-side `SettleMeal`;
- no browser reward-grant endpoint.

## Verified foundation

| Area | State | Evidence |
|---|---|---|
| M0 ingredient visual pipeline | done | 92/92 symbols, 161 frames |
| canonical beta provenance | done | recovered 0.9.143a SHA-256 `4493be9b...`; 24/24 content-equivalent to pinned n3r0 |
| historical content layers | done | `src/content/catalog.ts` + tests |
| ANEWON product routing | done | ADR-0009 merged in `anew-docs` |
| product security policy | done | `SECURITY.md` + `anewon.product.json` |
| production source maps | disabled | `vite.config.ts` |
| product-authority domain | active | opaque Platform subject, durable/idempotent placement/economy and read-only topology projection |
| service topology | done | exact authoritative occupancy/facing/walkability + synchronized Phaser snapshot |
| full visual corpus pipeline | active | R16: 2,481 linked symbols, 17,169 frames; deterministic generated web derivatives |
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
| 2026-09-19 | M3 service-topology gate 2 closed: 11/11 kitchen composites promoted, catalog/mapping 103/103, exact occupancy/facing/walkability, authenticated read-only topology route, synchronized Phaser topology and physical browser proof green in run 35450486931. |
| 2026-09-19 | M3 service-loop authority gate 1 closed: canonical admission/order/chef/waiter/eat/plate-clear contract, deterministic TS/Rust replay and atomic idempotent payout. |
| 2026-09-19 | M2 world/editor slice closed: five canonical wallDividers, wallpapers, door/window/floor/stacking and frozen browser goldens. |
| 2026-09-18 | ADR-0009 merged: Restaurant City formally routed as ANEWON SOCIAL_WEB Product; Platform/Runtime/product boundaries fixed. |
| 2026-09-18 | Product authority Rust foundation added with opaque ANEWON subject and idempotent checked state mutations. |
| 2026-09-18 | Visual pipeline upgraded from one unbounded PNG to deterministic bounded multi-atlas pages for the full corpus. |
| 2026-09-18 | Local-only BIN/XML decoder added; original historical bytes remain in Vault/research boundary. |
| 2026-07-31 | M0 closed: ingredient pipeline 92/92 symbols, 161 frames; BootScene/proxy proof and original tests green. |

## Blockers

- later 2010–2012 assets/data remain historically evidenced but byte recovery
  is unresolved;
- active service-loop identity/replay is not durable yet, so no live meal may
  trigger settlement;
- public/commercial distribution of legacy assets remains blocked absent an
  explicit rights basis.

## Next

1. define and persist one active service identity binding customer, order,
   chair/table, chef, kitchen and waiter to the authoritative topology;
2. drive explicit path/timing outcomes through the already validated service
   reducer and render the first live Phaser customer/chef/waiter actors;
3. prove deterministic replay/reopen of that active service state before any
   live server-side payout connection;
4. wire plate-clear to the existing server-only idempotent `SettleMeal` only
   after the durable identity gate is green;
5. capture one complete physical browser meal lifecycle and freeze it before
   expanding to drinks/toilet/cleaner branches.
