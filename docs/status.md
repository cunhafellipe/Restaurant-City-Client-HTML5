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

M2 world/editor parity is closed. M3 gates 1, 2, 3A, 3B and **3C** are
closed. The first live customer/chef/waiter presentation is durable and the
timer-driven lifecycle is now server-clocked, persisted, replay-safe and
read-only in the browser.

The next slice is authoritative **path-driven actor progression**. Chair
arrival, waiter travel/service and customer leaving must advance from
server-owned path completion rather than browser timers or teleportation.
Only after that path lifecycle is green may the live plate-clear boundary be
connected atomically to the already existing server-only settlement command.

### Latest checkpoint — M3 gate 3C server-driven clock/path timing boundary

- Persistence schema is **V6** with authoritative transition timestamps and
  explicit `AnchorTiming` migration for V5 active services. V5 replay never
  invents a historical timestamp.
- A server `ServiceTimeSource` is injectable. Deterministic fake-clock tests
  prove exact deadlines and catch-up behavior.
- Timer-driven phases use persisted deadlines; path-driven phases remain
  distinct and cannot be advanced merely because wall-clock time elapsed.
- Repeated authoritative reads are idempotent. Internal catch-up mutation IDs
  use a reserved namespace that public `Idempotency-Key` values cannot occupy.
- Read authority performs CAS-based catch-up before returning state. The same
  authoritative `server_now_ms` used for catch-up is projected with customer/
  order deadlines and remaining milliseconds.
- `GET /api/v1/restaurant/service` remains authenticated, same-origin,
  **read-only/no-store**. No browser reducer-event/timer/payout mutation route
  exists.
- TypeScript validates deadline/timer/remaining coherence fail-closed before
  Phaser accepts an active service.
- The physical Edge probe proves `serverNow`, deadlines and remaining values
  reach Phaser while the frozen customer/chef/waiter framebuffer remains
  byte-stable at block
  `c228300c562553d1a30157730628b8a3e539d3d315e3cb20ed6db6aa7106e2d4`.
- A physical redb test closes the database with a pending decision deadline,
  advances fake server time, reopens, performs exactly one persisted catch-up,
  reopens again and proves the repeated read causes **no duplicate write**.
- Product gate **35460391844** is GREEN on behavioral SHA
  `8e5f0a5986ef083c4bfcb95a986f4b243557abae`:
  **150/150 TypeScript**, **117/117 Rust**, catalog **104**, mapping
  **104 unique / 0 ambiguous / 0 missing**, WEB-NATIVE PASS, cargo
  fmt/clippy/test PASS, real Axum loopback PASS and **0 production npm
  vulnerabilities**.
- Artifact `10589658366`, SHA-256
  `567be26bbdf1ec7f940f29ae6c0b5e0910618fc1614defa973bb2df4e5cc7981`.

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
| product-authority domain | active | opaque Platform subject, durable/idempotent placement/economy, V6 service timing and read-only projections |
| service topology | done | exact occupancy/facing/walkability + durable service identity + server-driven timing projection |
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
| 2026-09-19 | M3 gate 3C closed: V6 server clock/deadlines, deterministic catch-up, read-only timing projection to Phaser and physical redb reopen/idempotency proof; gate 35460391844 GREEN with 150 TS / 117 Rust. |
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
- path-driven actor completion is not yet server-owned end-to-end, so the live
  meal cannot yet advance autonomously through chair/waiter/exit movement;
- `PlateCleared + SettleMeal` deliberately remains disconnected from the live
  service until authoritative path progression is proven;
- public/commercial distribution of legacy assets remains blocked absent an
  explicit rights basis.

## Next

1. implement authoritative path lifecycle for customer chair arrival, waiter
   collection/service travel and customer leaving, using the already recovered
   topology/pathfinder semantics;
2. persist/replay path identity/progress and expose only read-only actor
   position/progress to Phaser;
3. prove close/reopen continuation without teleporting or browser-authored
   completion;
4. then wire live `PlateCleared` to atomic/idempotent server-only
   `SettleMeal` in one transaction boundary;
5. capture one complete physical browser meal lifecycle
   customer → order → cook → serve → eat → clear → settlement and freeze it
   before expanding to drinks/toilet/cleaner branches.
