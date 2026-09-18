# 08 — Roadmap

Milestones are vertical slices. A milestone closes only when its acceptance
criteria are demonstrated with evidence (see `07-testing-and-qa.md`) and
`docs/status.md` is updated. Live state: `docs/status.md`.

| # | Milestone | Target state |
|---|---|---|
| M0 | Scaffold & pipeline proof | Project builds; backend proxy works; one asset SWF -> atlas -> animated sprite on screen |
| M1 | Asset pipeline complete | All 9 asset SWFs exported at full symbol coverage; audio + data JSONs; manifest loads |
| M2 | Core loop | Login/handshake, profile load, street + restaurant render from save, pan/zoom, editor buy/place/move/sell |
| M3 | Restaurant gameplay | Customers, waiters, cooks, cooking queue, dishes, coins/gourmet, level bar, save round-trip |
| M4 | Menus & progression | Recipe menu + dish levels, shops, hire/fire, awards, daily bonus, quiz, garden, expansion |
| M5 | Social & meta | Friends, visits, street ranking, rating, trade, mail, Food King, music shop, avatar/building customization |
| M6 | Polish & parity | Tutorials, performance pass, audio completeness, debug panel, full parity sweep, packaging |

## M0 — Scaffold & pipeline proof

- [x] `npm install`, `npm run dev`, `npm run check`, `npm test` all work.
- [x] Dev proxy: client can fetch `/bin-xml/ingredient.bin` through `:5173`.
- [x] `tools/extract-symbols.mjs` + `tools/build-atlases.mjs` convert
  `ingredient_asset.swf` (92 symbols, 100% coverage, report green).
- [x] Boot scene renders one exported animated sprite (idle<->grey
  timeline; see `tests/golden/m0/README.md`).
- [x] `git init` + first commit; `docs/status.md` template filled.

## M1 — Asset pipeline complete

- [ ] All 7 visual asset SWFs: 100% linked-symbol coverage, bounded atlas pages + multi-atlas JSON.
- [ ] `sound_asset.swf`: audio exported (ogg/webm + mp3) and playable.
- [ ] All `bin-xml` files -> typed JSON via `src/net/data/` readers; reader
  unit tests against file bytes.
- [ ] `manifest.json` generated and validated by the loader; regeneration is
  reproducible (run twice, identical manifest).
- [ ] `docs/11-data-formats.md` completed with verified reader mappings.

## M2 — Core loop

- [ ] Handshake + main batch RPC working against `:8090` (replay tests).
- [ ] `GameState` populated from `getUserProfile` (all fields).
- [ ] Street view renders from a saved profile; restaurant renders interior
  + exterior from placements, correct depth order.
- [ ] Camera: pan and zoom lever.
- [ ] Editor: buy item from shop, place on valid tiles, move, sell;
  audit-delimited save persists via `saveProfile` and survives reload.
- [ ] Login screen and session handling (reuse backend cookie flow).

## M3 — Restaurant gameplay

- [ ] Customer lifecycle end-to-end (spawn -> seat -> order -> eat -> pay ->
  leave) with hearts/satisfaction.
- [ ] Waiters carry dishes, clear tables; cooks staff stoves.
- [ ] Dish cooking: ingredients consumed, cook timers, dish levels' effects.
- [ ] Coins/gourmet/cash counters update live; level bar and level-ups.
- [ ] Autosave cadence matches original; save round-trip byte-tested.
- [ ] Performance budget pass with a full restaurant.

## M4 — Menus & progression

- [ ] Recipe menu: dish selection per stove, buy/level-up dish flows.
- [ ] Ingredient shop, cash shop, sell item, item info popups.
- [ ] Hire/sack employees; employee stats and energy.
- [ ] Awards, daily bonus, earnings recap.
- [ ] Daily quiz (credits), garden planting/harvesting, outside-area
  expansion.
- [ ] Tutorial first-session flow (`tutorials/`).

## M5 — Social & meta

- [ ] Friends list, visiting friends' restaurants (first-visit bonus),
  street ranking lists.
- [ ] Rating, trade/swap ingredients, mail, gift/invite flows.
- [ ] Food King mini-game playable end-to-end.
- [ ] Music shop (track purchase/persist), avatar editor, building
  customization, layout chooser.
- [ ] All popups from `06-ui-hud.md` implemented with correct flow graph.

## M6 — Polish & parity

- [ ] Full parity sweep: every P0 flow verified side-by-side; P1 divergence
  list closed or accepted in `docs/status.md`.
- [ ] Performance: pooling/culling/batching; 60 fps budget met.
- [ ] Audio completeness (all SFX + music, mute/persist).
- [ ] Debug panel behind `?debug=1`.
- [ ] ANEWON production integration: product-authoritative backend, Platform session/identity port,
  Runtime protected-content release path and browser smoke suite green. The
  legacy Dippys server remains a compatibility/golden harness, not the
  production trust root.
- [ ] Changelog + release notes; `docs/status.md` marks project done.

## Ordering notes

- M2 and M3 may partially interleave (editor needs customers to feel real),
  but a milestone's acceptance list is the gate regardless.
- Product-specific authoritative backend work belongs in this product and must preserve ADR-0009.
  Cross-product identity/runtime/security changes belong in Platform/Runtime
  and require the appropriate company architecture review. Do not silently
  extend the legacy compatibility server into ANEWON production architecture.
