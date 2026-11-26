# Issues progress (local only — nothing pushed per Steven)

Integration branch: `issues-integration` (worktree ../photobook_helper-integration), from main 4bad967.

Steven's decisions: no push until all issues done; #9/#10 decisions as proposed; editor in-browser mode removed (fold into #6a); #5 slim list keeps filter fields; NEW job: generated descriptions/keywords/objects stored in a separate sidecar file in the album folder (not photoinfo.json), read-only folders → shared fallback; catalog = cache. Runs after #2 merges (same tagging code).

## Round 1
- #11 fix/stable-server-port 050404f — review clean (0/0/4 minor; editor Restart not run by hand) — merged into issues-integration 5b992a4
- #3 filter-panel — building
- #2 regenerate-description — building

## Later rounds (from issues-plan.md)
- R2: #4a–d, #5a, #6a (+ remove editor in-browser mode), album sidecar job (after #2)
- R3: #9a–d, #7a(/b), #6b
- R4: #10a–d, #6c + spikes
- R5: #5b–d, #7b
- R6: #6d–f
- #2 regenerate-description a2d4c55 — review: 1 Important (empty caption overwrites) → fix round 1 sent
- #3 filter-panel f808281 — in review
## Round 2 started early (independent of #2/#3), base issues-integration 5b992a4
- #4 update-check (../photobook_helper-updates, rebasing) — 4a–4d, ports 5600s
- #5a fast-navigation (../photobook_helper-nav) — ports 5700s
- #6a media-registry (../photobook_helper-media) — + remove editor in-browser mode, ports 5800s
- album sidecar job: waits for #2 merge
- #2 fix f77b7c5 (empty caption + busy state) checked by controller → merged into issues-integration 4f42e0d (v0.1.37)
- album sidecar job started: album-tags-sidecar (../photobook_helper-sidecar), ports 5900s
- #3 review: 2 Important (prototype keys in choice(); panel switch not list-driven) → fix round 1 sent, rebase onto issues-integration, ports 5500s
- #3 fix 8436ff6 (Map lookup; list-driven panel controls) checked by controller → merged into issues-integration
- ROUND 1 DONE (#11, #2, #3)
- sidecar 4d73474 — review: 1 Critical (per-photo full reindex on open), 4 Important (debounce < model speed; no write backoff; read-only→writable overwrite + abs path leak [ruling: per-entry merge, no abs paths]; transient read error cached) + ⚠️ content key stability → fix round 1 sent
- #6a media-registry 3dc700c — review clean (0/0/6 minor; desktop build/self-test not run → do in final check) → merged
- #5a fast-navigation 5604d9f — in review
- #5a review: 2 Important (failed 1600px cached forever; old picture under new caption/actions) → fix round 1 sent to a6cce76
- #4 update-check 3720bf3 (v0.1.40, rebased on 3064692) — in review
- #5a fast-navigation 78a36f6 — re-review 1 clean (both Important fixed) → merged
## Round 3 started, base issues-integration f6f043d (v0.1.40)
- #9 gallery-keys-and-colour (../photobook_helper-keys, ports 5500s, opus a835aea) — 9a–9d; 9d after #4 merges if possible
- #7a faster-loop (../photobook_helper-loop, ports 5700s, sonnet a213451)
- #6b media-formats-2 (../photobook_helper-media2, ports 5800s, opus a3d57d8)
- Ruling: #6b proceeds without the "browser backend" answer — editor is desktop-only per Steven, so the question is moot.
- #4 review: 0C/4I/8m (I1 double close prompt loop; I2 silent invisible exit on failed install; I3 x-user-staging-id sent; I4 AppImage package-type=deb) → fix round 1 sent (+2 minors)
- #7a faster-loop 3278504 (v0.1.41) — in review
- #7a review clean (0/0/4 minor) → merged
- sidecar fix round 1 366eba4 (rebased on 4089c32, v0.1.42) — all 5 fixed per implementer; open 10k album 8 min → 3–5 s first, ~2 s after → scoped re-review
- sidecar re-review 1 clean (all 5 fixed, ⚠️ mitigated; minors: held folders not cleared, regenerate write delay up to 60 s, migrated timestamps) → merged
- #4 fix round 1 0ad73cc (rebased on 4089c32, v0.1.42) — scoped re-review sent to ae56b5f; note sidecar also bumped to 0.1.42 → version conflict on merge expected
- #4 re-review 1 clean (all 6 fixed; staging-id all-zero accepted; double pkexec accepted; manual install path never run) → merged 2407b1a, bump 0b18c30 v0.1.43; integration check (npm ci, typecheck, fast vitest) running
- integration 0b18c30 check: typecheck clean; npm test fast 1051/1055 (4 skipped), slow 299/300 — green (earlier 4 fails were missing fixtures in the worktree)
- #6b media-formats-2 1711c82 (on 9e28f24, v0.1.43) — in review; own BMP/ICO decoder; tests written after code
- #6 phase 4/5 spikes (LibRaw options; ffmpeg vs Chromium) started — research only → scratchpad/issue-6-spikes.md
- #6 spikes done → issue-6-spikes.md. RAW: PoC lightdrift-libraw (native) vs FlashRaw (WASM), not libraw-wasm; video: Chromium-only first, ffmpeg (LGPL BtbN) only if needed. User questions pending for 6d/6e (ask when R6 nears): FlashRaw 0.x ok? single-maintainer native ok? lossy DNG? RAW speed? editor RAW? download CC0 RAWs?; HEVC must play? posters for AVI/MTS/HEVC? +30/60 MB? GPL? editor videos?
- #6b review: 0C/3I/7m (I-1 gzipped .svg bomb; I-2 JPEG save of transparency → black; I-3 SVG block unverified in packaged/wasm, no selfTest) → fix round 1 sent (+ decoder length-before-alloc minor)
- #9 gallery-keys-and-colour 304b7a7 (on 0b18c30, v0.1.44) — in review
- Photo Tool design doc written to main checkout docs/photo-tool-design/ (README + 4 parts, 13 screenshots, ~60k words), describes issues-integration 0b18c30; NOT committed. C:\PhotoToolDemo (screenshot copy of fixtures) left for user to delete (rm blocked by safety check). #9 304b7a7 in review.
- #6b fix round 1 01d426f (on 0b18c30, v0.1.44; packaged Windows self-test 8/8 ok) → scoped re-review sent to aabfb4f. NOTE #9 also at v0.1.44 → bump after second merge
- #6b re-review 1: 1 Important R1-1 (sniff reads 512 B; 600 spaces + <svg bypass) → fix round 2 sent
- design doc committed on issues-integration 8a849d3 (v0.1.44); main checkout copy removed. #9 and #6b both at 0.1.44 → will conflict on version, take ours + bump
- #9 review: 0C/2I/11m (I1 delete silently capped at 500; I2 multi-file Ctrl+C untested on Linux, toast always says copied) → fix round 1 sent
- #6b re-review 2 clean (R1-1 closed; minor R2-M1 editor export fallback to sharp-by-path) → merged
## Round 4 (partial)
- #6c raw-previews (../photobook_helper-raw, ports 5800s) from 40a89a5
- Ruling: RAW fixtures are synthetic (generated in make-fixtures: TIFF-structured DNG/CR2/NEF/ARW etc. with embedded JPEG previews), no downloads or checked-in camera files — the download/check-in question stays open for Steven; cost if wrong: real-camera quirks untested until then
- #9 fix round 1 c5b447c (on 8a849d3, v0.1.45 — clashes with #6b's 0.1.45 → merge with --ours + bump) → scoped re-review sent to a7d3dd2
- #9 re-review 1 clean (4 new minors) → merged; test-file conflicts resolved as #9 version + #6b appended tests; v0.1.46; full verification running
- integration 0ef6ca5 (v0.1.46) verified: typecheck, npm test 1191+302, Playwright 62 passed both projects
- #10 timeline-reopen-whatsnew (../photobook_helper-timeline, ports 5500s) from 0ef6ca5
- Ruling: #10's localStorage question → small UI settings (thumbSize, splitter widths, open sections) stay in localStorage (#11 made it survive restarts); only 'last' (folder, photo, view, scroll) goes in the server-side ui_state — smallest change, issue's 'Decisions (proposed)' still met; cost if wrong: a later move of 3 keys
- CLEANUP (Steven): removed 10 finished worktrees; deleted 15 merged local branches (kept main, issues-integration, raw-previews, timeline-reopen-whatsnew, claude/bold-mendel); deleted origin/gallery-score as funvill (split-programs and fix/ci-node26 already gone); closed #2 #3 #4 #9 #11 with a 'done locally, not pushed' comment; gh back on ssmethurst. Open: #5 #6 #7 #10. origin/filter-panel kept (not in main).
