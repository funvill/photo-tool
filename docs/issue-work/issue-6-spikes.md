# Issue #6 spikes: Phase 4 (full RAW decode) and Phase 5 (video)

Date of research: 2026-11-25. Repo read at `photobook_helper-integration` (Electron 45.4.1, sharp ^0.35.5, libheif-js ^1.23.5, project licence MIT). No product code written, nothing committed, nothing installed system-wide. I ran `npm view` and `npm pack` into a scratch folder (no install scripts) and ran `node` against `libraw-wasm`'s files there.

Every number is tagged **[measured]** (I ran it), **[published]** (a registry, release page or README says it) or **[estimated]** (my reasoning). Not measured, and why, is listed in "What I did not do".

(`gh issue view` printed nothing in this environment, so the issue text was read through `gh api repos/funvill/photo-tool/issues/6`: https://github.com/funvill/photo-tool/issues/6)

## What the code looks like today (the plug-in points)

- `shared/core/mediaFormats.ts`: `MediaKind = 'image' | 'raw' | 'video'` already exists. `MEDIA_FORMATS` has jpeg, png, webp, heif. A RAW or video format is one entry plus a handler (guard test fails on extension lists elsewhere).
- `shared/server/mediaHandlers/index.ts`: `MediaHandler { id, preview(file, ctx): string|Buffer, working?(file, ctx): string, image(file): Sharp }`. `workingPath()` uses `working()` else `preview()`. `HandlerContext` = `{ derivedDir, contentHash() }`. A handler without a format, or a format without a handler, throws at load.
- `heic.ts` is the template for a decoded-copy handler: write `derived/<sha256>.jpg` once, return its path, plus an in-memory `image()`. The issue's `probe()`, `cost` and `sniff()` fields do not exist in the interface yet (Phase 1 shipped the smaller version). A video handler needs `probe()` added.
- `scripts/desktop/build.mjs`: "Nothing is downloaded: every input is already in node_modules". Native modules go in `EXTERNAL` (`scripts/desktop/programs.mjs`), are copied platform-filtered (`keepFile`, as done for onnxruntime-node), and electron-builder unpacks all of `node_modules/**` (`asarUnpack`). Resources the server reads as plain files go in `extraResources` -> `assets/` via `scripts/collect-resources.ts`.
- **Precedent that matters for licensing:** `libheif-js` is **LGPL-3.0** [published, npm] and is already shipped as a WASM bundle in `resources/libheif/` with its licence texts copied beside it (`scripts/collect-resources.ts` lines 62-90). So the project already ships an LGPL engine as a separate, replaceable file with licence text. An LGPL LibRaw handled the same way is consistent with what it does today.
- `photo-tool/electron/selfTest.ts`: the `taggingWorkerLoads` step starts the unpacked worker with `new Worker(file)` and waits for a `pong` that carries the loaded onnxruntime version. `.github/workflows/desktop.yml` has `required_step: taggingWorkerLoads` for Photo Tool and `''` for the editor, so a new step is made mandatory by adding a `required_step` value. The editor currently has no required step, so a RAW check there would need a matrix change.

---

# Spike 1: full RAW decode (Phase 4)

## Options found

| # | Option | What it is |
|---|--------|-----------|
| A | `libraw-wasm` 1.6.0 | LibRaw compiled with Emscripten, browser-first. https://github.com/ybouane/LibRaw-Wasm |
| B | `lightdrift-libraw` 1.0.1 | LibRaw 0.22.2 vendored, Node-API 8 addon with prebuilds. https://github.com/unique01082/lightdrift-libraw |
| C | `librawspeed` 1.0.129 | Another N-API LibRaw addon. https://github.com/pixFlowTeam/librawspeed |
| D | `libraw.js` 3.0.0 / `libraw` 0.1.4 | Older addons. https://github.com/justinkambic/libraw.js |
| E | `flashraw` 0.5.0 | **Not LibRaw.** A Rust RAW decoder compiled to WASM, MIT OR Apache-2.0. https://github.com/ybouane/flashraw |
| F | LibRaw CLI (`dcraw_emu`) in `extraResources` | Official LibRaw downloads: https://www.libraw.org/download |
| G | `dcraw` / `dcraw-wasm` | dcraw is GPL and unmaintained since 2018. Not credible; listed only to rule it out. |

## Comparison

| | A libraw-wasm | B lightdrift-libraw (native) | C librawspeed | D libraw.js / libraw | E flashraw (WASM) | F LibRaw CLI |
|---|---|---|---|---|---|---|
| **Licence of the package** | ISC [published, npm] | MIT [published] | MIT [published] | LGPL-2.1 / MIT [published] | MIT OR Apache-2.0 [published] | LibRaw: LGPL-2.1 or CDDL-1.0, your choice [published: https://www.libraw.org/about] |
| **Licence of the decoder inside** | LibRaw: LGPL-2.1 or CDDL-1.0. The package ships **no LGPL/CDDL text** [measured: grep of the tarball found none] and labels itself ISC, so we would add the notice ourselves | LibRaw 0.22.2, LGPL-2.1 or CDDL-1.0; texts are in the tarball (`THIRD_PARTY_NOTICES.md`) [measured] | LibRaw, same | LibRaw, same | Own Rust code, no LibRaw: **no LGPL obligation at all** | LibRaw, same |
| **Closed-installer implication** | Choose CDDL-1.0 (file-level copyleft, no relink rule) or LGPL as a separate replaceable .wasm file, as libheif already is | LibRaw is **statically linked into the .node**. CDDL-1.0 is the clean choice (modified LibRaw files must be offered as source, our code is untouched). LGPL also works because the .node is a replaceable file and source is vendored, but a lawyer-level reading is needed | same as B | same | None | Separate executable: "mere aggregation", the easy case for either licence |
| **Size added** | wasm 1.42 MB, package 2.07 MB unpacked, 673 KB tarball [measured] | prebuilds: win32-x64 1.59 MB, linux-x64 2.79 MB [measured]; 4.5 MB tarball for all 5 platforms, only one is kept per platform by a `keepFile`-style filter | win32-x64 1.15 MB [measured] | n/a | 6 wasm variants of 3.8 to 5.5 MB each (9.0 MB tarball) [measured]; ship only `flashraw_simd_threads.wasm` (4.0 MB) plus the scalar one, about 8 MB, or the README's "about 892 KiB brotli" for one [published] | `dcraw_emu` about 1 to 3 MB [estimated]; no official binary listed |
| **Prebuilt win-x64 + linux-x64 for Electron 45** | Not needed (WASM) | **Yes for both** (Node-API 8, `prebuilds/win32-x64`, `linux-x64`) [measured]. Node-API is ABI-stable so no `@electron/rebuild`; their CI loads it in **Electron 36.9.5 on Windows x64 only** [published: docs/platform-support.md]. Linux needs glibc 2.31+ [published]. Electron 45 not tested by them | win32-x64 and darwin-arm64 only, **no linux** [measured] | libraw.js: Ubuntu and macOS only, "help with Windows solicited" [published]; libraw 0.1.4 abandoned in 2022 | Not needed (WASM) | Official Windows zip only (`LibRaw-0.22.3-Win64.zip`, MSVC) and macOS; **no Linux binary**, we would build it in CI [published: https://www.libraw.org/download] |
| **Speed, 24 MP** | No published figure for libraw-wasm. flashraw's author says libraw-wasm is 8.8x to 15x slower than flashraw and puts flashraw at about 100 ms in that comparison [published, second-hand via the LibRaw-Wasm README]. Real-world LibRaw full-quality demosaic is order 0.5 to 2 s for 24 MP on one core [estimated]; WASM adds maybe 1.2 to 2x [estimated] | Native LibRaw: same order, no WASM penalty; 45 ms for a thumbnail unpack in its own docs [published, docs/TESTING.md]. No 24 MP numbers [published] | none | none | 24 to 25 MP, decode only, M1 Ultra all cores: 12 to 15 ms vs LibRaw 131 to 323 ms [published, self-reported, https://github.com/ybouane/flashraw]. In Node WASM: 1.2 to 1.6x native single-thread; Pentax K-50 16 MP rgba8 912 ms vs 660 ms native 1-thread [published: https://github.com/ybouane/flashraw/blob/main/docs/wasm.md]. **Decode only, not the colour-managed rgba8 path we need** | Process start (about 50 to 100 ms on Windows [estimated]) plus the same LibRaw time as native; output through a file on disk |
| **Camera coverage** | All of LibRaw (about 1,000+ cameras; the page does not state a number: https://www.libraw.org/about). Built without a JPEG codec so lossy-DNG is not covered [estimated] | All of LibRaw 0.22.2. **Built with only `USE_ZLIB`** [measured: `binding.gyp`], so JPEG-compressed (lossy) DNG, e.g. many phone and Lightroom DNGs, is probably not decodable [estimated, needs a fixture]. Docs list Canon, Nikon, Sony, Fuji, Panasonic, Olympus, Pentax, Leica, DNG and test 7 families with CC0 fixtures [published] | LibRaw | LibRaw | 2,008 of 2,016 raw.pixls.us files decode (99.6%), 1,600+ camera entries, about 40 formats [published, self-reported]. Misses: Light L16, Casio CAM, JPEG-in-DNG. Coverage of new bodies depends on one author | LibRaw 0.22.3, the best coverage of any option |
| **Maintenance health** | v1.6.0 on 2026-07-02, last push 2026-10-26, 57 stars, 6 open issues, 4 contributors [measured via `gh api`] | Created 2025-08, last push 2026-10-11, **9 stars, 0 open issues, one maintainer** [measured]. Young and small | Last push 2025-10, 3 stars | libraw.js: npm 2023, 7 issues | **Repo created 2026-10-02, 0.x, 128 stars, 1 open issue, one author**; no automatic CI; Windows and Linux ARM not regularly tested; benchmarks self-reported [published] | LibRaw itself: 1,638 stars, last push today, 0.22.3 released 2026-10-26, 0.22.2 on 2026-07-16 [measured] |
| **Works in Node/Electron main?** | **Does not construct in Node.** `new LibRaw()` creates `new Worker(new URL('./worker.js', import.meta.url))`, the browser global. In Node 24.21: `typeof Worker` is `undefined` and the constructor throws "Worker is not defined" [measured]. Needs a `worker_threads` shim, or using its `libraw.js` Emscripten glue directly in our own worker, as `heic.ts` does for libheif. Also returns one 72 MB RGB array for 24 MP that has to cross a thread boundary | Yes, Node-enabled main or utility process only [published] | | | Yes, first-class Node support, `worker_threads` pool included [published] | Spawn, no native-module risk |

## How each plugs into the existing code

Common shape (same as `heicHandler`):

- Add RAW entries to `MEDIA_FORMATS` (`kind: 'raw'`, `capabilities: { editInPlace: false, alpha: false, saveAs: 'jpeg', animated: false }`), and one `rawHandler` in `mediaHandlers/index.ts`.
- `preview()` stays the Phase 3 embedded-JPEG path and is not changed by this spike.
- `working(file, ctx)`: decode with the engine, write `derived/<sha256>.raw.jpg` (JPEG at quality about 95, or a 16-bit PNG/TIFF if colour depth matters), return the path. `image(file)` for in-memory small previews can use the embedded JPEG or `halfSize` decode.
- Fallback rule from the issue: use `working()` only for zoom, export, edit copies, and files with no usable preview.

| Option | Engine call inside `working()` | Thread |
|---|---|---|
| A | load `libraw.js` glue in a `worker_threads` worker (needs our own shim); `open(bytes, {useCameraWb: true, outputBps: 8})`, `imageData()`, hand RGB to `sharp(rgb, {raw:{width,height,channels:3}}).jpeg().toFile()` | worker pool like `heic.ts` |
| B | `await raw.loadFile(file); (await raw.createJPEGBuffer({quality: 95}))`. The package also pulls its own `sharp ^0.35.4`; it dedupes to our copy at the same range, but check the Linux sharp patch (`linux/patch-sharp.mjs`) is not bypassed by a second copy. Add `lightdrift-libraw` to `EXTERNAL` in `programs.mjs`; add a `keepFile`-style filter so only the current platform's `prebuilds/<platform>-<arch>/` is copied | its own async work (libuv threads); still run in a utility process if we want crash isolation |
| E | `FlashRaw.openFile(file)`, `decode({output:'rgba8', ...})`, `sharp(raw)`; use `flashraw/worker` pool. No native module, no `EXTERNAL` entry, the `.wasm` files go in `resources/` like libheif | `flashraw/worker` |
| F | `execFile(dcraw_emu, ['-T','-w', file])` to a temp TIFF, then sharp to JPEG | child process, crash isolated |

**Desktop self-test:** mirror `pingTaggingWorker`. Add a step `rawDecoderLoads` to `photo-tool/electron/selfTest.ts` that loads the engine from the **installed app's unpacked path** and decodes one tiny checked-in RAW/DNG (or just opens the module and reports its version if no fixture can be checked in), then add `required_step: rawDecoderLoads` for Photo Tool in `desktop.yml`. For the editor (also reads RAW through the shared registry) the matrix has `required_step: ''`; decide whether to add the step there.

## Recommendation (Spike 1)

**Do not ship `libraw-wasm`.** It does not run in Node as published, it ships no licence text, and it has no speed data. **Native Node-API `lightdrift-libraw` is the fastest-to-working route and the closest match to "LibRaw as the issue wants it"**, but it is a 9-star, 3-month-old, one-person package with Windows tested only on Electron 36, and a build without JPEG (so no lossy DNG). **FlashRaw is the technically best fit** (WASM in Node, no native module to rebuild, MIT/Apache so **no LGPL or CDDL obligations**, about 8 MB, 99.6% of the raw.pixls.us corpus) but it is a 5-week-old 0.x project, not LibRaw, and every performance number is self-reported.

Proposed decision order:

1. Put the decoder behind `working()` so the choice is replaceable (the interface already allows it).
2. First PoC: **`lightdrift-libraw` as `EXTERNAL`** if the user wants LibRaw's coverage and accepts a CDDL notice and a young dependency; and **`flashraw` as a second PoC branch** measured on the same files. Pick by measurement.
3. If neither passes the CI self-test on Windows and Linux (Electron 45, installed app), fall back to **F: build `dcraw_emu` from LibRaw 0.22.3 source in CI** and bundle it in `extraResources`. This is the most boring, most debuggable, crash-isolated option, and the one with no dependency on a small npm maintainer.

## Risks (Spike 1)

- **Maintainer risk**: B and E are each one author and young. Vendoring (copy of the tarball into the repo, or pinning an exact version plus a lockfile hash) limits damage. B vendors LibRaw source, which also satisfies the "provide source" side of LGPL/CDDL.
- **Native ABI**: Node-API 8 is stable, but only Windows on Electron 36 is tested upstream. The repo already has a Linux native-addon problem (glib, see `linux/patch-sharp.mjs`). A second native addon on Linux is exactly where that class of bug appears. Needs a Linux CI run in the installed AppImage and deb.
- **Lossy DNG** (JPEG-compressed) likely missing from B. Also check JPEG-XL DNG (E needs a bigger binary downloaded at run time: avoid, `flashraw_simd_jxl.wasm` is another 5 MB if bundled).
- **Memory**: a 24 MP RGB decode is 72 MB (8-bit) or 144 MB (16-bit), more inside LibRaw. With 4 concurrent decodes that is 300 to 600 MB. Cap concurrency at 2 and keep it out of the scan path.
- **Colour**: "as the camera or LibRaw renders them by default" (issue non-goals) is a decision, not a default: LibRaw without `useCameraWb` looks flat. Define it in the PoC (camera white balance, sRGB, auto-brightness off). FlashRaw's default will look different from LibRaw's, so users switching engines would see different pictures.
- **Licence housekeeping**: whichever LibRaw is used, add LibRaw's licence text to `collect-resources.ts`'s licence bundle, as is done for libheif. For B, record that the CDDL-1.0 option is chosen.
- **Speed claims are unverified**: no 24 MP number on this machine for any option.

## Proof-of-concept PR (Spike 1) would contain

- No change to the registry behaviour. One new RAW entry in `mediaFormats.ts` (e.g. `.dng`, `.cr2`, `.nef`, `.arw`) and a `raw` handler with `preview()` returning embedded JPEG (or, for the PoC, `working()` only).
- `working()` for the chosen engine behind a small `rawEngine` interface so both options can be benchmarked.
- A throw-away benchmark script `scripts/bench-raw.ts` (not in CI) that decodes one CC0 24 MP file with each engine and prints wall time, peak RSS and the JPEG size.
- `rawDecoderLoads` self-test step plus `required_step` in `desktop.yml`; `programs.mjs` `EXTERNAL` entry and a platform filter for B; licence text in `collect-resources.ts`.
- Vitest decode test with 3 to 4 CC0 raws from raw.pixls.us (pinned SHA-256, fixtures downloaded by `scripts/make-fixtures.ts` as the issue plans; **not** checked in), plus one lossy DNG to prove or disprove the gap.
- A CI-only job that unpacks the Windows and Linux installers and runs the self-test.

## Questions only the user can answer (Spike 1)

1. Is a **0.x, 5-week-old, single-author** decoder (FlashRaw) acceptable if it is faster and carries no LGPL/CDDL, or must the decoder be LibRaw?
2. Is it OK to **depend on a 9-star, single-maintainer npm package** (`lightdrift-libraw`) for a native addon, or should we vendor and build LibRaw ourselves in CI (more work, full control)?
3. **Lossy DNG** and **new camera bodies**: how important? (Phone DNGs, Lightroom exports.)
4. How slow is acceptable for a zoomed RAW on first view: under 1 s? under 3 s? (Decides whether we can use full-quality demosaic at all or only half-size.)
5. Is the **Photobook Editor** to open RAW too, or only Photo Tool? (It decides whether the editor's self-test needs a RAW step.)
6. Which CDDL-vs-LGPL stance is wanted for the installer's licence notices (I recommend CDDL-1.0, a lawyer should confirm).
7. May I download CC0 sample RAWs from raw.pixls.us to a scratch folder and run the real 24 MP benchmark? (I did not, see below.)

---

# Spike 2: video (Phase 5)

## Options

| # | Option |
|---|---|
| A | Bundled static `ffmpeg-static` 5.3.0 (+ `ffprobe-static` 3.1.0) |
| B | `@ffmpeg-installer/ffmpeg` + `@ffprobe-installer/ffprobe` |
| C | Own **LGPL** ffmpeg/ffprobe, shared build, in `extraResources` (e.g. BtbN `lgpl-shared`, or built in CI, trimmed to decode-only) |
| D | Chromium only: `<video>` for playback; poster frame by offscreen `<video>` + canvas; `nativeImage.createThumbnailFromPath` on Windows; duration from a small Node-side container parser |
| E | D for playback plus an optional ffmpeg for what Chromium cannot play (not a transcoder, only "poster and probe") |

## Licence (GPL vs LGPL)

- FFmpeg is LGPL-2.1+ unless built with `--enable-gpl` or `--enable-nonfree`; for LGPL you must not use libx264 and the like, use dynamic linking (DLLs on Windows), ship the exact source and configure line, and add attribution in the about box and download page [published: https://ffmpeg.org/legal.html].
- **`ffmpeg-static` 5.3.0: npm licence `GPL-3.0-or-later`** [published]. It downloads the binary from `eugeneware/ffmpeg-static` release `b6.1.1` (FFmpeg 6.1.1) at **install time** [measured: package.json and README], and the binary is a GPL static build (John Van Sickle on Linux, gyan.dev-style on Windows). Last repo push 2026-03-21, 1,412 stars, 34 open issues [measured via `gh api`]. The postinstall download also breaks `build.mjs`'s rule that "nothing is downloaded".
- **`@ffmpeg-installer/*`: the wrapper says LGPL-2.1, but the platform packages `win32-x64` and `linux-x64` are `GPLv3`** (4.1.0, June 2022; `@ffprobe-installer` 5.1.0/5.2.0, `GPL-3.0`, 2023) [published, npm]. Unmaintained since 2022/2023. Do not rely on the wrapper's LGPL label.
- `ffprobe-static` is labelled MIT but is a binary build, so the binary's own licence applies (GPL for the static builds). 3.1.0, June 2022.
- **So neither npm package satisfies the issue's "an LGPL build" requirement.** An LGPL build exists from https://github.com/BtbN/FFmpeg-Builds (12k stars, updated daily): `ffmpeg-master-latest-{win64,linux64}-lgpl[-shared]`. It is decode-capable for H.264/HEVC/AAC through FFmpeg's own LGPL decoders; it simply has no x264/x265 encoders, which we do not need for a poster frame.
- Our project is MIT and open source: shipping a GPL ffmpeg as a separate executable is allowed (aggregation), but it makes the installer as a whole carry GPL notices and source-offer obligations that a future closed or commercial build could not keep. If that is not a concern, the GPL builds are fine.
- HEVC patents: FFmpeg's own page says commercial products may face patent fees and does not give a clear answer [published, https://ffmpeg.org/legal.html]. Chromium's H.264/HEVC licensing is already part of every Electron download. Ask a lawyer if the installer is ever sold.

## Installer size

| | Per platform, uncompressed on disk | Compressed | Source |
|---|---|---|---|
| `ffmpeg-static` binary `ffmpeg-win32-x64` | 82.8 MB | 29.6 MB (.gz) | [published, release assets of b6.1.1] |
| `ffmpeg-static` binary `ffmpeg-linux-x64` | 79.8 MB | 29.4 MB | same |
| `ffprobe` win32-x64 / linux-x64 | 82.7 MB / 79.7 MB (release) ; 61 MB / 62 MB in `ffprobe-static` | 29.5 MB / 29.3 MB | [published] / [measured: `npm pack` of ffprobe-static] |
| Both ffmpeg + ffprobe | about 165 MB on disk | **about 59 MB added to each installer** (installers are already compressed; NSIS LZMA and deb xz behave like gzip here) | [estimated from the above] |
| `ffmpeg` only (probe with `ffmpeg -i`, read stderr) | about 80 MB | about 30 MB | [estimated] |
| BtbN LGPL `win64-lgpl-shared.zip` | | 83.0 MB (archive includes ffmpeg, ffprobe, ffplay, DLLs, docs) | [published] |
| BtbN LGPL `linux64-lgpl-shared.tar.xz` | | 66.9 MB | [published] |
| BtbN static LGPL `win64-lgpl.zip` / `linux64-lgpl.tar.xz` | | 179 MB / 143 MB | [published] |
| Chromium-only (D) | **0 MB** (Electron already ships H.264/AAC) | 0 | |

The issue's guess "about 70 to 80 MB" holds for one static binary; with ffprobe too, the installer grows by about 60 MB, and the unpacked install by about 165 MB. A trimmed, decode-only LGPL build made in CI would probably be 15 to 30 MB per binary [estimated, not tried]. The existing build already notes onnxruntime-node's 290 MB of all-platform binaries as the size to beat.

## What Chromium in Electron plays

- Chromium (and Chrome) containers: MP4 including QuickTime/MOV, WebM, Ogg, Matroska (MKV), WAV, HLS. Open video codecs: AV1, VP8, VP9. **H.264 and HEVC are Chrome-branded only**, and HEVC also needs hardware support [published: https://www.chromium.org/audio-video/].
- Electron's `build/args/all.gn` sets `ffmpeg_branding = "Chrome"` and `proprietary_codecs = true` [measured: https://raw.githubusercontent.com/electron/electron/main/build/args/all.gn], so **H.264 + AAC in MP4/MOV/M4V plays**. That covers iPhone and Android phone video that is H.264.
- **HEVC (iPhone default "High Efficiency", many Android phones): not reliable.** Chromium hands HEVC to the OS decoder: VideoToolbox on macOS, Media Foundation on Windows (needs the HEVC Video Extensions from the Microsoft Store and a supported GPU) [published, second-hand: https://github.com/BobStrogg/teslacam-browser/pull/79, which also tested Electron 45.1.0 on Linux: `canPlayType` and `isTypeSupported` returned no support for hvc1/hev1, while H.264 worked]. Electron's own issue says it supports what Chrome supports: https://github.com/electron/electron/issues/27943. **On Linux, HEVC will not play. On Windows it depends on the user's machine.** I could not run Electron here (the repo's `node_modules/electron/dist` is not downloaded), so this is a source-based claim; the PoC must probe it (below).
- Not played, by container or codec: **AVI, MPEG-TS (`.mts`, `.m2ts`), WMV/ASF, FLV, most 3GP with non-H.264 video, DivX/Xvid, ProRes, MPEG-2** [estimated from the Chromium list above; Matroska plays only if its codecs are supported]. The issue's list `.avi .mts .m2ts .3gp` is mostly in this group.
- A `.mov` file must be served with a `Content-Type` of `video/mp4` (or `video/quicktime`) from the `/media` route; Chromium sniffs the container but the MIME helps. Range requests: `206 Partial Content`, `Accept-Ranges: bytes`, since the media element seeks with Range [estimated, standard behaviour; verify in PoC].

## Poster frames and durations for 10,000 files

**Option A/C (ffmpeg):** one process per file, `ffmpeg -ss <t> -i file -frames:v 1 -vf scale=1600:-2 out.jpg` is fast with input seeking, about 100 to 400 ms per file typical, dominated by process start plus keyframe seek [estimated, not measured]. With 4 in parallel, 10,000 files is about 5 to 15 minutes in the background. `ffprobe -v quiet -print_format json -show_format -show_streams` gives duration, size, codec, rotation, creation_time in one call. Handles every container and codec in the issue's list, including AVI and MTS.

**Option D (Chromium only):**
- **Duration, size, rotation, creation date: do not open each file in `<video>`.** For MP4/MOV/M4V/3GP, read the `moov/mvhd` (duration, creation time) and `trak/tkhd` (width, height, rotation matrix) boxes in a small pure-TypeScript parser, the same idea as the Phase 3 RAW parser: it reads about 1 KB to a few KB at the head or tail of the file, a few ms per file. For WebM/MKV an EBML reader of about 100 lines. Ready-made options: `mediainfo.js` 0.3.9 (BSD-2, WASM, 4.5 MB, updated 2026-11-15) [measured via `npm view`], `music-metadata` 13.0.1 (MIT, 1.2 MB, updated 2026-11-25; it reads video container metadata such as mp4 and mkv) [measured], `mp4box` 2.6.0 (BSD-3, 2.5 MB). AVI/TS/WMV would have no duration, which is acceptable because they cannot be played anyway.
- **Poster frame:** a pool of 2 to 3 hidden `BrowserWindow`s (or an offscreen `<video>` in the existing renderer) that load the file via the `/media` route, `video.currentTime = min(1, duration*0.1)`, wait for `seeked`, draw to a canvas at 400 and 1600 px, `toBlob('image/jpeg')`, and post bytes to the server to write `derived/<hash>.poster.jpg`. Hardware decode is used when available. Cost per file about 150 to 600 ms including media-element startup [estimated, not measured]; with 3 workers 10,000 files is about 10 to 50 minutes [estimated]. This **must be lazy**: poster for visible grid items first, rest at idle, cached by content hash so it happens once.
- **`nativeImage.createThumbnailFromPath(path, {width,height})`**: **macOS and Windows only; no Linux**; the Windows implementation ignores `size.height` and scales height from width [published: https://www.electronjs.org/docs/latest/api/native-image]. It asks the shell for the thumbnail Explorer would show, so it is fast (cache-backed) on Windows, but it depends on installed codecs (an iPhone HEVC clip has no thumbnail without the Microsoft HEVC extension), gives no duration, and the docs do not mention video. **So it is an optional Windows fast path, not the base.** Linux must use the offscreen `<video>` route and gets **no poster for HEVC**, only the "Can't play this video here" placeholder.
- A poster failure for one file must not stop a scan: record `posterFailed` and show a generic video tile.

## Packaging

- **Option A/C binaries**: do **not** put them in `asar` (executables cannot run from inside it). The repo's `asarUnpack: ['node_modules/**']` would unpack `ffmpeg-static/ffmpeg(.exe)` automatically, but `ffmpeg-static` downloads its binary at `npm install` time and `build.mjs` runs on a clean `node_modules`, so CI would need network and a version pin. Cleaner: **`extraResources`**, `scripts/desktop/ffmpeg/` fetched with a pinned URL and SHA-256 by one explicit script (not install scripts), copied to `assets/ffmpeg/`, per-platform filter. Resolve the path through `shared/server/resources.ts` like libheif. On Linux set the executable bit (`afterPack`, since electron-builder preserves modes from `extraResources` but a git checkout on Windows does not), and add to `.deb` nothing (no new system libraries for a static build; shared LGPL builds need their `.so` files beside the binary and `LD_LIBRARY_PATH`/RPATH `$ORIGIN`).
- **Option D**: no packaging change. A new route `/api/gallery/media` with Range support, and CSP in the renderer must allow `media-src` for the app's own origin. A pure-TS parser adds no native module; `mediainfo.js` adds a 4.5 MB WASM file.
- **Self-test (mandatory either way)**: the existing `required_step` pattern. A: `ffmpegRuns` runs `ffmpeg -version` from the installed `resources/assets` path. D: `videoPlays` in a hidden window: `document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"')` and grab one frame from a tiny checked-in H.264 MP4 (a few KB), then also record the HEVC result without failing.

## Recommendation (Spike 2)

**Phase 5a: Chromium-only (D) for playback, a pure-TS MP4/MOV/WebM probe for duration, size and rotation, and an offscreen-`<video>` poster pool.** No new binary, no new licence, 0 MB added, and it plays what most people have (H.264 MP4/MOV, WebM). Show "Can't play this video here" plus "Open in default app" for the rest, which is already what the issue's step 17 says. Use `createThumbnailFromPath` as an optional fast path on Windows only if the PoC shows it is a clear win.

**Phase 5b, only if the user answers "HEVC phone videos must play" or "poster for every container": add an LGPL ffmpeg (C), not `ffmpeg-static` or `@ffmpeg-installer`.** Both npm packages ship GPL binaries, are old (6.1.1 for `ffmpeg-static`, 2022 for the installers), and `ffmpeg-static` downloads at install. Use a pinned BtbN `lgpl-shared` build (or a CI-built trimmed decode-only one) in `extraResources`, for posters and probes of files Chromium cannot play, and still do **not** transcode for playback (HEVC would play only on Windows with the extension; on Linux you would show the poster and "Open in default app").

## Risks (Spike 2)

- **HEVC on Linux never plays in Electron's `<video>`**, and on Windows it depends on a paid-or-store codec and GPU. iPhones record HEVC by default. This is the single biggest user-visible gap and it should be put to the user plainly.
- **No poster at all for files Chromium cannot decode** (AVI, TS, HEVC on Linux) without ffmpeg.
- **10,000 posters** through hidden windows is a lot of CPU and RAM; it needs a throttled queue, lazy generation and a cancel on folder change. The memory of a hidden window is about 80 to 150 MB each [estimated].
- **Orientation**: Chromium applies the rotation matrix to playback but a canvas draw uses the decoded frame; check phone portrait clips (the PoC fixture should be a portrait H.264 clip).
- **GPL contamination** if `ffmpeg-static` is picked casually. The installer then carries GPL-3 obligations.
- **Size**: ffmpeg+ffprobe about +59 MB in each installer, about +165 MB installed, doubled in CI storage and update downloads (the NSIS config has `differentialPackage: false`, so every update re-downloads the whole installer).
- **Security**: a hostile video through ffmpeg is a larger attack surface than through Chromium's sandboxed media pipeline. Run ffmpeg with `-nostdin`, `-protocol_whitelist file`, a timeout and a size cap; never pass user text as a URL.

## Proof-of-concept PR (Spike 2) would contain

- `video` format entries in `mediaFormats.ts` (`.mp4 .mov .m4v .webm`, `kind: 'video'`, `animated: true`) and a `video` handler with the new `probe()` method added to `MediaHandler`; `preview()` returns the cached poster, `image()` decodes the poster.
- `shared/server/videoProbe.ts`: the mvhd/tkhd (MP4/MOV) and EBML (WebM) readers, with Vitest tests on tiny checked-in clips (a few KB each, generated fixtures).
- `GET /api/gallery/media?path=` with Range support, with tests for 200, 206, 416 and path-safety (same checks as `/full`).
- A poster pool in the Electron main process (2 workers) writing `derived/<hash>.poster.jpg`, behind a feature flag.
- A **probe page** the PoC runs once in the real Electron 45 build: `canPlayType` and `MediaCapabilities.decodingInfo` for avc1, hvc1, hev1, vp09, av01 on Windows and Linux, and `createThumbnailFromPath` on a video on Windows. The output is posted in the PR so decisions rest on facts, not on the sources above.
- A benchmark of posters for 200 generated clips to extrapolate to 10,000.
- Self-test step `videoPlays` (`required_step` in `desktop.yml`).
- Optional second PR for option C: the pinned-hash fetch script, `extraResources` entry, `ffmpegRuns` self-test and the licence text.

## Questions only the user can answer (Spike 2)

1. **Must HEVC phone videos play in the viewer?** (If yes on Linux, nothing but a bundled transcoder or an "open in default app" button will do; on Windows it needs the user's HEVC extension.)
2. **Is a poster frame needed for every video**, including AVI, MTS and HEVC on Linux? (If yes, ffmpeg is required.)
3. **Accept +60 MB in each installer and +165 MB installed** for ffmpeg + ffprobe, or +30 MB for ffmpeg only, or 0 MB with Chromium only?
4. **GPL acceptable?** (`ffmpeg-static`, simple, GPL-3 notices) or **LGPL only** (BtbN `lgpl-shared` or a CI-built trimmed build, more build work)?
5. Should the **Photobook Editor** show videos on its shelf, or images only? (Open question in the issue; it changes whether the editor needs the video self-test and the poster pool.)
6. How many videos does a typical user folder hold? (10,000 videos is very different from 10,000 photos with 200 videos; it decides whether posters can be lazy-only.)
7. Is a first poster that takes a few seconds on a cold folder acceptable (lazy, visible-first), or must it be ready after the scan?

---

# What I did not do, and why

- **No 24 MP RAW benchmark.** The repo has no RAW fixtures, and downloading a sample from raw.pixls.us is a download beyond what the task allowed (npm packages only), so I did not do it. Every speed number above is published or estimated. I did run `libraw-wasm` under Node 24.21: it fails at construction (see table), so it could not have been timed anyway without a shim.
- **Native addons were not loaded** on this machine. `.node` files from 3-star and 9-star packages were not executed. Their loading under Electron 45 is for the PoC's CI job.
- **Electron was not run.** `node_modules/electron/dist` is not present in the repo, so the HEVC and `createThumbnailFromPath` claims come from sources, not from this machine.
- **ffmpeg binaries were not downloaded.** Sizes come from the GitHub release metadata and from the `ffprobe-static` npm tarball I packed.
- **The LibRaw Win64 zip was not downloaded**; I could not list its `bin/`. The download page names no standalone executable and no Linux binary.
- Camera-count figures for LibRaw are not stated on its pages; I did not invent one.

# Sources

- https://github.com/funvill/photo-tool/issues/6 (read through `gh api`)
- https://github.com/ybouane/LibRaw-Wasm, https://www.npmjs.com/package/libraw-wasm
- https://github.com/unique01082/lightdrift-libraw (README, `docs/platform-support.md`, `binding.gyp`, `THIRD_PARTY_NOTICES.md` read from the packed tarball)
- https://github.com/pixFlowTeam/librawspeed, https://github.com/justinkambic/libraw.js, https://www.npmjs.com/package/libraw
- https://github.com/ybouane/flashraw and https://github.com/ybouane/flashraw/blob/main/docs/wasm.md
- https://www.libraw.org/about and https://www.libraw.org/download, https://github.com/LibRaw/LibRaw
- https://ffmpeg.org/legal.html
- https://github.com/eugeneware/ffmpeg-static (release b6.1.1 assets), https://github.com/BtbN/FFmpeg-Builds (latest release assets)
- https://www.chromium.org/audio-video/
- https://raw.githubusercontent.com/electron/electron/main/build/args/all.gn
- https://github.com/electron/electron/issues/27943, https://github.com/BobStrogg/teslacam-browser/pull/79
- https://www.electronjs.org/docs/latest/api/native-image, https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules
- npm registry via `npm view` (licences, versions, dates, sizes) and `npm pack` of libraw-wasm, flashraw, lightdrift-libraw, librawspeed, ffmpeg-static, ffprobe-static and the two `@ffmpeg-installer` / `@ffprobe-installer` wrappers into `pk/` in the scratchpad.
