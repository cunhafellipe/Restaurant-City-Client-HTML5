# 04 — Asset pipeline

Converts the original SWF/`bin-xml` assets into web formats. Everything the
browser loads is **generated**; nothing is hand-drawn. Pipeline scripts live
in `tools/` (Node, run offline) and emit into `public/assets/generated/`.

## Source inventory

| SWF | Stage | fps | Kind | Content |
|---|---|---|---|---|
| `game.swf` | 760x600 | 25 | pure code | game logic (no assets) |
| `preloader.swf` | 760x600 | 25 | pure code | preloader logic |
| `preloader_asset.swf` | 640x700 | 25 | embed-swf | loading screen graphics, bookmark button |
| `game_asset.swf` | 640x700 | 25 | embed-swf | HUD, panels, buttons |
| `avatar_asset.swf` | 550x400 | 12 | import-script | avatar parts (hair, faces, clothes...) |
| `indoor_asset.swf` | 550x400 | 25 | embed-swf | furniture, appliances, decor |
| `outdoor_asset.swf` | 550x400 | 25 | embed-swf | scenery, pavement, fences, trees |
| `ingredient_asset.swf` | 550x400 | 12 | embed-swf | ingredient icons |
| `perk_asset.swf` | 550x400 | 12 | embed-swf | perk/power-up icons |
| `sound_asset.swf` | 550x400 | 12 | embed-mp3 | SFX + music |

(Source of this table and the FFDec invocation patterns:
`../decompiled/setup-all-swfs.ps1`.)

The per-asset projects under `../decompiled/<name>_asset/` already hold
rebuilt asset SWFs and `_assets/assets.swf` symbol libraries from the Flash
resurrection. The pipeline may consume those, but the **original root SWFs
remain the source of truth** — regeneration must always be possible from
them.

## Target formats

- **Sprites:** PNG atlases + Phaser multi-atlas JSON for M0 (lossless PNG
  tier of ADR-0004; WebP tier is a later pipeline upgrade), one or more bounded atlas pages per source SWF per scale tier. Pages are
  deterministic, max 2048x4096 in the current PNG tier, and consumed as one
  Phaser multi-atlas.
- **Audio:** ogg/webm + mp3 dual-format with a per-track manifest
  (Web Audio via Phaser). Export from `sound_asset.swf`'s embedded MP3s.
- **Data:** typed JSON generated from the `bin-xml` files by the readers in
  `src/net/data/` (see doc 11). The client consumes the JSON at runtime.
- **Strings:** lang JSON per locale from `lang_en[1].bin` / `lang_fr[1].bin`.

## Implemented tooling (M0, verified against `ingredient_asset.swf`)

| Script | What it does | FFDec invocation used |
|---|---|---|
| `tools/extract-symbols.mjs` | Parse tag tree + linkage, export sprite frames, write `extract.json` | `-dumpSWF`, `-export symbolClass`, `-format sprite:png -export sprite` |
| `tools/build-atlases.mjs` | Shelf-pack frames into bounded deterministic PNG pages + multi-atlas JSON (pngjs, no native deps) | — |
| `tools/build-manifest.mjs` | Emit `manifest.json` + coverage report | — |
| `tools/verify-pipeline.mjs` | Re-extract from the original SWF, compare sets, fail on <100% | `-dumpSWF`, `-export symbolClass`, `-format sprite:png -export sprite` |
| `tools/pipeline.mjs` | Runs all stages in order | — |
| `tools/build-audio.mjs` | (M1) demux `sound_asset.swf` MP3s | `-export sound` |

Verified facts about the extraction (recorded so M1 reuses them):

- FFDec `-export sprite` emits one folder per sprite named
  `DefineSprite_<chid>[_<ExportName>_<ClassName>]` containing one PNG per
  timeline frame (`1.png`, `2.png`, ...). Frame content is the rendered
  composite (children included).
- Frame labels come from parsing `-dumpSWF` (indented tag tree:
  `FrameLabel`/`ShowFrame` per sprite). `ingredient_asset` frames are
  `idle`/`grey`; unlabeled frames use zero-padded indexes.
- The linkage tables (`-export symbolClass` CSV) contain both the
  ExportAssets and SymbolClass entries; the pipeline dedupes by chid and
  excludes chid 0 (main-timeline root marker).
- `ingredient_asset.swf`: 92 linked sprites, 161 frames total, 65 unnamed
  inner wrapper sprites (composited into their parents, not linked —
  excluded), 100% coverage achieved.
- Pipeline output is reproducible: two consecutive runs produce
  byte-identical artifacts (verified by SHA-256 comparison).

## Pipeline stages

1. **extract** — FFDec CLI (`C:\Program Files (x86)\FFDec\ffdec-cli.exe`)
   exports symbols as frame images + placement/transform info, or script
   assets for `import-script` SWFs. Deterministic output naming.
2. **normalize** — apply 9-slice info, frame bounds, pivot points
   (registration), and animation timelines from the symbol data.
3. **atlas** — pack frames, emit WebP/PNG + multi-atlas JSON.
4. **audio** — demux embedded MP3 -> ogg/webm + mp3.
5. **manifest** — emit `manifest.json` (see contract below) and a coverage
   report comparing exported symbols against the SWF symbol list. **100%
   symbol coverage or the milestone fails.**

## Manifest contract

```jsonc
{
  "version": 1,
  "atlases": [
    { "id": "indoor", "file": "atlases/indoor.webp",
      "json": "atlases/indoor.json", "source": "indoor_asset.swf" }
  ],
  "audio": [ { "id": "music_main", "ogg": "audio/music_main.ogg",
               "mp3": "audio/music_main.mp3" } ],
  "data": [ { "id": "ingredients", "file": "data/ingredients.json",
              "source": "ingredient[1].bin" } ],
  "langs": [ { "code": "en", "file": "data/lang_en.json" } ],
  "coverage": { "ingredient_asset": { "symbols": 92, "exported": 92,
                  "frames": 161, "pct": 100 } }
}
```

The loader (`src/net`/game layer) validates manifest entries and fails with
actionable errors naming the missing file.

**Phaser loading rules:** the JSON is a multi-atlas (`textures` array), so it
MUST be loaded with `this.load.multiatlas(key, jsonUrl)` — `load.atlas`
treats its second argument as a texture image URL and silently produces an
empty/missing texture. Additionally, `textures[].image` is a
**site-root-relative path** (relative to `public/`), not a path relative to
the JSON file: Phaser's multiatlas loader resolves image URLs against
`loader.path` (empty by default), NOT against the JSON's directory. Callers
must not pass a `path` argument to `multiatlas` — the JSON is
self-contained. `tests/lib/atlas-contract.test.mjs` guards both rules.

**Phaser animation rule:** `anims.create` frame entries are
`{ key: <textureKey>, frame: <frameName> }`. A bare `{ key: 'x' }` treats
`x` as a *texture* key and looks for frame 0 — the atlas frame key is the
`frame`, and the texture key is the one passed to `load.multiatlas`.

## Naming rules

- Frame keys: `<sourceSwf>/<symbol>/<frameName>` lowercased, no spaces.
- `frameName` defaults to timeline frame label; unnamed frames get numeric
  indexes padded to 3.
- Never rename symbols across regeneration runs — keys are a stable public
  contract for scenes and systems.

## Acceptance for M0/M1 (from the roadmap)

- M0: `ingredient_asset.swf` -> atlas -> one animated sprite renders in the
  Boot scene; coverage report green for that SWF.
- M1: all 7 visual asset SWFs exported at full coverage; audio exported; data JSONs
  for all `bin-xml` files; manifest loads in the dev server.

## Guardrails

- The pipeline writes only into `public/assets/generated/` and a scratch
  dir under `client-html5/tools/.work/`. It must **never write into
  `../decompiled/`** or modify original files.
- Regeneration is reproducible: same inputs -> byte-identical manifests.
- Coverage failures are build errors, not warnings.
