# On-device tagging models: measurements (2026-11-24)

Task 1 of `docs/superpowers/plans/2026-11-24-gallery-tagging.md`. Tool: `scripts/tagging/measure.ts`
(`npx tsx scripts/tagging/measure.ts --cache <dir> [--only florence|clip]`).

**Set-up.** `@huggingface/transformers` 4.3.2 (onnxruntime-node 1.30.0, whose Windows x64 CPU and
DirectML binaries ship inside the npm package, so its blocked install script is not needed on Windows).
CPU only, `intraOpNumThreads = 6` (half of 12 logical CPUs), AMD Ryzen 5 3600, Windows 11. 8-bit (`q8`,
the `*_quantized.onnx` files) only: Steven agreed to download those (about 1.7 GB in total) and not the
full-precision ones.

**Photos.** The 19 JPEGs of `fixtures/generated/trip`. These are *generated* pictures (a gradient sky,
mountains, a red circle and a word such as "Lake" or "Cafe"), not real photos. So these runs prove the
models load and run in Node here and measure their speed, but they say little about description or
keyword quality on real photos; that, and the thresholds, are a check on real photos (handoff).

## Results

| Choice | Repo @ commit | Download | Load | Seconds a photo (mean / max) | Licence |
|---|---|---|---|---|---|
| Descriptions, smaller | `onnx-community/Florence-2-base-ft` @ `e88a44e` | 277 MB | 49 s (first, cold) | 6.0 / 6.7 | MIT |
| Descriptions, larger | `onnx-community/Florence-2-large-ft` @ `04ace74` | 832 MB | 160 s (first, cold) | 20.5 / 42.0 | MIT |
| Keywords, smaller | `Xenova/clip-vit-base-patch32` @ `6b7c523` | 156 MB | 6 s | 0.06 / 0.11 | MIT |
| Keywords, larger | `Xenova/clip-vit-large-patch14` @ `c307790` | 434 MB | 28 s | 0.51 / 0.54 | MIT (OpenAI CLIP; the Xenova card names none) |

Florence-2 time is both tasks together: `<MORE_DETAILED_CAPTION>` (up to 100 new tokens) and `<OD>`
(up to 256). Each file's size and SHA-256 were checked against Hugging Face's LFS record at that commit;
all matched. The full list is in `src/core/tagModels.ts`.

At these speeds a folder of 2,000 photos takes about 3.5 hours with Florence-2 base plus CLIP base, and
about 12 hours with Florence-2 large. Overnight is acceptable (spec), so no graphics-card acceleration
for now.

## Quality on the generated photos

- **Florence-2 base** describes each picture in a few sentences, reads the word in it ("…the word
  "Garden"…") and the colours. It often calls a drawn sun a "red eye" or an "oar": they are drawings.
  `<OD>` finds almost nothing in them (mostly "poster"), as expected for flat drawings.
- **Florence-2 large**: similar sentences, a little more careful ("A graphic of a lake with mountains in
  the background"), sometimes wrong ("A phone screen is displayed"), three times slower. `<OD>` is no
  better here ("animal", "poster").
- **CLIP base**: the word drawn in the picture wins (harbour, lake, market, cafe, museum, garden), at a
  similarity of about 0.28–0.30 against about 0.25–0.27 for the next words. Small margins.
- **CLIP large**: the same winners with clearer margins (about 0.25–0.27 against 0.21).

## Thresholds chosen (to check on real photos)

- **Keywords:** a word's score is its share after a softmax over the vocabulary of `100 × similarity`
  (CLIP's own scale). Keep the top 12 scoring at least **0.05**, for both models. On these pictures that keeps
  the right word and a few colour or shape words ("gradient", "sunset").
- **Search by meaning:** the cosine similarity of the text to the picture. **0.27** for CLIP base (true
  matches here: 0.27–0.31; wrong ones up to 0.28, so expect some noise) and **0.24** for CLIP large (true:
  0.26–0.29; wrong ones up to 0.23).
