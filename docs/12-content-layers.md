# 12 — Historical content layers

The ANEWON revival does **not** replace the Dippys 0.9.143a baseline with an
untraceable "latest" dump. It treats the proven beta corpus as an immutable
bottom layer and adds later historical data only when the bytes are validated.

`src/content/catalog.ts` implements deterministic family-level overlays.
A validated 2.21.2 `restaurant.bin`, for example, may override only
`restaurant`; recipe/avatar/front/etc. continue to fall through to 0.9.143a
until matching later bytes are recovered.

Three confidence levels exist:

- `canonical-baseline`: frozen ANEWON P1 / Dippys-compatible baseline.
- `validated-historical`: recovered historical bytes with hash/provenance.
- `reference-only`: version/post/filename evidence; **never loaded at runtime**.

Original/proprietary bytes stay in the local Vault. Git stores code,
manifests, hashes and provenance only. A later acquisition stage will generate
a local runtime manifest from validated Vault objects and feed it to this layer
resolver.

Current P0 late-data targets: 2.20.3 front/quiz/restaurant/recipe, 2.21.2
restaurant/front/recipe/avatar/quiz, and the 2.21.2-era challenges dataset.
