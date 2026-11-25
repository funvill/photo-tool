# Split into Photo Tool and Photobook Editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the one Electron program with a `--gallery` mode into two programs, Photo Tool and Photobook Editor. They live in `photo-tool/`, `photobook-editor/` and `shared/`, and each has its own Windows and Linux installers.

**Architecture:**
- Moving code is decided by the import graph. A module used by one program goes to that program; a module used by both goes to `shared/`. A boundary test enforces this.
- The Electron main process becomes one shared `runDesktopApp(program)` in `shared/electron/`, plus a short `main.ts` per program that describes the program.
- One root `package.json`. Each program has its own Vite config, build output folder (`dist/<program>/`), electron-builder config and `product.json`.

**Tech Stack:** Electron, TypeScript, React 19, Vite, Vitest, Playwright, esbuild (`scripts/desktop/build.mjs`), electron-builder (NSIS, deb, AppImage), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-25-split-photo-tool-and-editor-design.md`

## Global Constraints

**Names, IDs and folders**
- Product names: **Photo Tool** (was Photobook Gallery) and **Photobook Editor** (was Photobook Studio).
- appIds: `app.phototool.desktop` and `app.photobookeditor.desktop`. On Windows the AppUserModelID equals the appId.
- Linux package and executable names: `photo-tool` and `photobook-editor`.
- Installer names: `Photo Tool Setup <version>.exe` and `Photobook Editor Setup <version>.exe`. On Linux: `${name}-${version}-${arch}.${ext}`.
- `product.json` `repository`: `github:funvill/photo-tool` in both.
- Maintainers: `Photo Tool <photo-tool@localhost>` and `Photobook Editor <photobook-editor@localhost>`.
- Top-level folders: `photo-tool/`, `photobook-editor/`, `shared/`. At the end, `src/` and `electron/` no longer exist.
- Data folders under `%APPDATA%` (or the Linux and macOS equivalent), with ` Dev` appended when not packaged:
  - `Photobook Editor` (was `Photobook Studio`);
  - `Photo Tool` (was `Photobook Gallery`);
  - shared photo-info fallback: `Photo Tools Shared\photoinfo` (was `<editor data>\photoinfo`).

**Environment variables**
- Each program reads `${PREFIX}_DATA_DIR`, `${PREFIX}_PROFILE_DIR`, `${PREFIX}_PORT`, `${PREFIX}_WEB_PORT`, `${PREFIX}_RESOURCE_ROOT` and `${PREFIX}_DESKTOP_DEV_URL`.
- The prefix is `PHOTOBOOK` for the editor (unchanged) and `PHOTO_TOOL` for Photo Tool, replacing `PHOTOBOOK_GALLERY_*`.
- Default ports: the editor keeps web 5173 / API 5174; Photo Tool keeps web 5175 / API 5176.
- The shared fallback can be moved with `PHOTOINFO_FALLBACK_DIR`.
- Build-only variables (`PHOTOBOOK_LINUX_SHARP`, `PHOTOBOOK_APPIMAGE_TOOLSET`) keep their names.

**Running from source**
- `./data/photobook-editor`, `./data/photo-tool`, `./data/photoinfo-shared`.

**Behaviour**
- Nothing changes apart from the names, the data folders, the removed "Open Gallery" link and menu item, and the removed `--gallery` switch.
- Photo Tool takes a folder as its first non-flag argument.
- Code identifiers containing "gallery" (`galleryApi`, `/api/gallery/...`, `gallery.css`, `GalleryApp`, IPC channel names `gallery:*`) stay as they are. Text a person sees says "Photo Tool".

**Data carry-over**
- A program's new data folder is made by moving (renaming) its old one, only when the new one does not exist.
- If the move fails, the program shows a message and quits. It never starts on an empty folder.
- Stored keys stay: the IndexedDB name `photobook-studio` and the backup header `app: 'Photobook Studio'`.

**Removed**
- `.github/workflows/pages.yml`, the `build:pages` and `preview:pages` commands, `docs/WEB_VERSION.md` and the README's "Use it in your browser" section.
- The editor's in-browser backend code stays in `photobook-editor/`, unused.

**Repository rules (from the project and Steven)**
- Never read, test with, list or commit `photos/`, `data/` or `trial-output/`.
- Never run a dev or desktop command without pointing `${PREFIX}_DATA_DIR`, `${PREFIX}_PROFILE_DIR` and `PHOTOINFO_FALLBACK_DIR` at a temporary folder, so the real `./data` and `%APPDATA%` folders are never moved by a test run.
- Commit as `git -c user.name="SWS-Chipkin" -c user.email="sws-dev@chipkin.com" commit ...`, with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run `npm version patch --no-git-tag-version` before every commit.
- Move files with `git mv` so history follows them.
- Never pull from or push to `upstream`.
- Push only to `origin`: `gh auth switch -u funvill`, push, then `gh auth switch -u ssmethurst`.
- Work on branch `split-programs`, cut from `main`.

**Test baseline**
- `npm run typecheck` passes.
- `npx vitest run` gives 998 passed and 4 skipped (v0.1.16).
- Playwright: the editor and gallery projects pass.
- A task ends green. The number of unit tests only changes where a task says so. The counts given in tasks ("998 + 3 new") assume the earlier tasks added exactly what they say; what matters is that the count is the previous task's count plus the new tests, with nothing lost.

## Review Focus

1. **The old program is still running when the new one first starts.** The old folder is locked, so the move fails. The new program says the old one must be closed first and quits, with nothing moved and nothing created. (Task 5: `carryOver` refuses when the rename throws.)
2. **Someone ran the new program once, then the old one again.** Both the old and new folders now exist. The new folder is used and the old one is left untouched, never merged. (Task 5: `carryOver` with both present.)
3. **Photo Tool is started with a folder argument.** This happens from Explorer's "Open with", a shortcut or a second launch, in both the packaged form (`[exe, folder]`) and the dev form (`[electron, appPath, folder]`). That folder opens; flags and their values are never taken for the folder. (Task 5: `launchFolder` cases.)
4. **A star set in Photo Tool on a read-only folder shows in the editor.** Both programs must resolve the same fallback folder for the same machine and the same packaged state. (Task 5: `photoInfoFallbackDir` gives the same path for both programs. Task 8: the dev scripts give both servers the same folder.)
5. **The installed Photo Tool is missing a resource it used to get from the shared build** (fonts for the page, world-atlas, libheif). Photo Tool's start-up resource check lists exactly what its server reads, and its self-test opens a folder with a HEIC fixture and shows a place. (Task 6: the `checkResources('photo-tool')` test, and the CI self-test in Task 9.)

---

### Task 1: Direct imports, and an import-graph checker

The gallery reaches the editor's whole book model through the `src/core` barrel (`src/core/index.ts`). Until that stops, the import graph says nearly all of `src/core` is used by both programs.

**Files:**
- Create: `scripts/import-graph.ts`
- Create: `src/core/photoAnalysis.ts`
- Modify: `src/core/model.ts`: move `interface PhotoAnalysis` (and only the types it needs) into `photoAnalysis.ts`, and have `model.ts` re-export it.
- Modify: every gallery file that imports `'../../core'` or `'../../../core'`, plus `src/server/media.ts` and `src/server/photoEditRender.ts`. Each imports the module that defines the name instead:
  - `photoEdit`: `isIdentityEdit`, `parseEdit`, `editFormatFor`, `editPlan`, `EditFormat`, `PhotoEdit`;
  - `photoFacts`: `PhotoExif`, `format*`, `megapixels`, `aspectRatio`;
  - `galleryEdit`: `normalisePeople`, `parseLocation`, `locationToSave`, `toDateTimeLocal`, `fromDateTimeLocal`;
  - `histogram`;
  - `photoAnalysis`: `PhotoAnalysis`.
- Test: `tests/import-graph.test.ts`

**Interfaces:**
- Produces:
  - `importClosure(entries: string[], root: string): Set<string>` returns repo-relative, forward-slash paths of every file reached through relative imports. Relative imports include `import`/`export ... from`, bare `import '...'`, `import()`, `new URL('...', import.meta.url)` and `<script src="...">` in `.html`. Extensions are resolved in the order `.ts .tsx .mts .cts .js .mjs .cjs .css .json .html`, then `index.*`. `node_modules` is skipped.
  - `crossings(root: string, rules: { from: string; mayImport: string[] }[]): { file: string; imports: string }[]` checks each file under each rule's `from` folder and lists every relative import that resolves outside `from` and outside every `mayImport` folder.
  - Tasks 2 to 11 use both.

- [ ] **Step 1: Write the failing test** `tests/import-graph.test.ts`
  - `importClosure` on a temp tree (`a.ts` imports `./b`; `b.ts` has `export * from './c'`; `c.css`; `page.html` with `<script src="./a.ts">`) returns all four files.
  - `crossings` on a temp tree where `x/one.ts` imports `../y/two` with rule `{ from: 'x', mayImport: [] }` returns `[{ file: 'x/one.ts', imports: 'y/two.ts' }]`.
  - **"the gallery reaches no book code":** the closure of the gallery's entries is `src/gallery/server/main.ts`, `src/gallery/web/index.html`, `src/gallery/web/main.tsx` and `src/gallery/server/tagging/worker.ts`. That closure contains none of `src/core/book.ts`, `src/core/templates.ts`, `src/core/generator.ts`, `src/core/index.ts` or `src/core/model.ts`.
- [ ] **Step 2: Run** `npx vitest run tests/import-graph.test.ts`.
  - Expected: FAIL. `scripts/import-graph.ts` does not exist; once it does, the last test fails because the closure has `src/core/index.ts`.
- [ ] **Step 3: Implement** `scripts/import-graph.ts`, `src/core/photoAnalysis.ts`, and the direct imports listed under Files.
- [ ] **Step 4: Run** `npx vitest run tests/import-graph.test.ts`, then `npm run typecheck`, then `npx vitest run`.
  - Expected: PASS. Typecheck clean. 998 + 3 new passed, 4 skipped.
- [ ] **Step 5: Record the module sets for Tasks 2 to 4.**
  - Write `docs/superpowers/plans/2026-11-25-split-module-sets.md` with three sorted lists from `importClosure`, with all test files excluded:
    - **both:** files in the editor's closure *and* the gallery's;
    - **photo-tool only;**
    - **editor only.**
  - Editor entries: `src/server/main.ts`, `src/web/index.html`, `src/web/main.tsx`.
  - Gallery entries: as in Step 1.
  - Electron files are not in either list; Tasks 5 to 7 sort them by hand.
  - Expected: the "both" list has about 20 files: `src/photoinfo/*`, `src/core/{photoEdit,photoAnalysis,photoFacts,...}`, `src/server/{media,photoEditRender,places,resources,heic}`, `src/shared/{desktopApi,places}`, `src/web/{desktop,eta}`, `src/web/components/{Icon,Modal,HoverPreview}`, `src/web/{fonts,styles}.css`. No book modules.
- [ ] **Step 6: Commit** `refactor: gallery imports core modules directly, not the book barrel`, after bumping the version.

### Task 2: `shared/`

**Files:**
- Move with `git mv`: every file on Task 1's "both" list, as follows:
  - `src/photoinfo/*` → `shared/photoinfo/`;
  - `src/core/X` → `shared/core/X`;
  - `src/server/X` → `shared/server/X`;
  - `src/shared/X` → `shared/desktop/X` (desktopApi) or `shared/server/` (places);
  - `src/web/X` and `src/web/components/X` → `shared/web/X` and `shared/web/components/X`.
- `src/core/index.ts` keeps re-exporting the moved core modules from their new place (`export * from '../../shared/core/photoEdit'`), so editor code that uses the barrel keeps working.
- **CSS:** `shared/web/fonts.css` is moved whole. `src/web/styles.css` is split:
  - `shared/web/base.css` gets the rules the gallery page uses: CSS custom properties, element resets, `.btn*`, `.muted`, `.small`, modal and icon rules, and any selector a `shared/web/components/*` or `src/gallery/web/**` component uses.
  - `src/web/styles.css` keeps the rest and starts with `@import '../../shared/web/base.css';`.
  - `src/gallery/web/main.tsx` imports `shared/web/fonts.css` and `shared/web/base.css` instead of the editor's files.
- **Tests:** test files whose imports now all resolve into `shared/` move to `shared/tests/`. Using Task 1's list as a guide: `photoinfo.test.ts`, `photo-facts.test.ts`, `photo-edit.test.ts`, `photo-edit-render.test.ts`, `media-exif.test.ts`, `heic.test.ts`, `eta.test.ts`, and any other test that imports shared code only. `tests/support/helpers.ts` moves to `shared/tests/support/helpers.ts` if both sides use it.
- `vitest.config.ts`: `include` covers `tests/**`, `shared/tests/**`, `photo-tool/tests/**` and `photobook-editor/tests/**`.
- `tsconfig.json`: `include` adds `shared`, `photo-tool` and `photobook-editor`.
- Test: `shared/tests/boundaries.test.ts`

**Interfaces:**
- Consumes: `crossings` and `importClosure` (Task 1).
- Produces: the `shared/` layout above. `shared/tests/boundaries.test.ts` gets a rule added by each later task.

- [ ] **Step 1: Write the failing test** `shared/tests/boundaries.test.ts`.
  - **"shared imports nothing outside shared":** `crossings(root, [{ from: 'shared', mayImport: [] }])` is `[]`.
  - **"the gallery page looks the same":** a vitest-free assertion that `src/gallery/web/main.tsx` imports `shared/web/base.css` and not `src/web/styles.css`, read as text.
- [ ] **Step 2: Run** `npx vitest run shared/tests/boundaries.test.ts`.
  - Expected: FAIL, because `shared/` does not exist.
- [ ] **Step 3: Do the moves** listed under Files, and fix every import, including in `scripts/` and `tests/`.
- [ ] **Step 4: Run** `npm run typecheck` and `npx vitest run`, then `npx playwright test --project=gallery`.
  - Expected: typecheck clean. Unit tests 1001 passed + 2 new, 4 skipped. Gallery e2e all pass, which proves the gallery page still renders and works with `base.css`.
- [ ] **Step 5: Screenshot check of the CSS split.**
  - Add a temporary line to the first test of `tests/e2e/gallery.spec.ts`, after the grid has loaded: `await page.screenshot({ path: 'test-results/split-css-gallery.png', fullPage: true })`.
  - Run `npx playwright test --project=gallery` once on `main` (in a separate worktree) and once on this branch, keeping both PNGs.
  - Compare the two by eye. Record "same" or the difference in the ledger. A difference must be fixed before committing.
  - Remove the temporary line before committing.
- [ ] **Step 6: Commit** `refactor: move code both programs use into shared/`.

### Task 3: `photo-tool/` (server, page, tests)

**Files:**
- Move:
  - `src/gallery/server/**` → `photo-tool/server/**`;
  - `src/gallery/web/**` → `photo-tool/web/**`;
  - the photo-tool-only `src/core` modules (`gallerySort`, `galleryStacks`, `galleryMap`, `galleryViewer`, `galleryEdit`, `photoScore`, `previewZoom`, `tagModels`, plus anything else on Task 1's photo-tool list) → `photo-tool/core/`;
  - `src/web/virtualGrid.ts` → `photo-tool/web/virtualGrid.ts`;
  - `tests/support/fakeTagging.ts` → `photo-tool/tests/support/`;
  - every test that imports only photo-tool and shared code → `photo-tool/tests/`, and `tests/e2e/gallery.spec.ts` → `photo-tool/tests/e2e/gallery.spec.ts`.
  - The `src/core/index.ts` lines for the moved gallery modules go (the editor doesn't use them; Task 1 showed none of their names in editor code). If typecheck says otherwise, the module belongs on the "both" list: move it to `shared/core/` instead and note it in the ledger.
- Create `photo-tool/vite.config.ts`:
  - `root: photo-tool/web`, `build.outDir: dist/photo-tool/web`;
  - dev port `PHOTO_TOOL_WEB_PORT ?? 5175`, with `/api` proxied to `PHOTO_TOOL_PORT ?? 5176`;
  - `define: { __APP_VERSION__ }`;
  - `server.fs.allow` covering `shared`.
- Modify `vite.config.ts`, the editor's (still at the root until Task 4): delete the `galleryPage()` plugin and its comments.
- Modify `photo-tool/server/main.ts`:
  - env `PHOTO_TOOL_PORT`, `PHOTO_TOOL_DATA_DIR`, `PHOTOINFO_FALLBACK_DIR`;
  - default data `./data/photo-tool` and default fallback `./data/photoinfo-shared`. Task 8 adds carry-over of the old `./data/gallery`; until then the new defaults hold only test data.
  - it serves `dist/photo-tool/web` in production.
- Modify `shared/server/resources.ts`: `webDir()` takes the program's built-page folder from its caller instead of assuming `dist/web`. Signature: `webDir(program: 'photo-tool' | 'photobook-editor'): string`. From source it returns `<project>/dist/<program>/web`; with a resource root, `<root>/web`.
- Modify `playwright.config.ts`. The `gallery` project is renamed `photo-tool`:
  - its `testDir` is `photo-tool/tests/e2e`;
  - its webServer runs `vite build --config photo-tool/vite.config.ts && tsx photo-tool/server/main.ts`;
  - env `PHOTO_TOOL_PORT` = `PHOTO_TOOL_E2E_PORT ?? 5186`, `PHOTO_TOOL_DATA_DIR` = `test-results/e2e-photo-tool`, `PHOTOINFO_FALLBACK_DIR` = `test-results/e2e-photo-tool-photoinfo`;
  - it no longer depends on the editor's build. Remove `needGalleryPage`.
- Modify `scripts/desktop/build.mjs`, a temporary bridge until Task 6: build Photo Tool's page too (`vite build --config photo-tool/vite.config.ts`). `scripts/collect-resources.ts --web` copies `dist/photo-tool/web/index.html` to `<resources>/web/gallery.html` and its assets beside it, so the single desktop build still works.
- `package.json` scripts added:
  - `dev:photo-tool`: Vite plus `tsx watch photo-tool/server/main.ts`;
  - `build:photo-tool`: `tsc --noEmit && vite build --config photo-tool/vite.config.ts`;
  - `e2e:photo-tool`: `playwright test --project=photo-tool`.

**Interfaces:**
- Consumes: Task 2's `shared/` paths.
- Produces: `webDir(program)`, `photo-tool/server/app.ts`'s `createGalleryApp` (unchanged name), `dist/photo-tool/web/index.html`.

- [ ] **Step 1: Add the boundary rule and a test.**
  - In `shared/tests/boundaries.test.ts`: `{ from: 'photo-tool', mayImport: ['shared'] }` gives `[]`.
  - New test **"photo-tool builds its own page"**: after `vite build --config photo-tool/vite.config.ts` (run via `execFileSync` in a `beforeAll`, with a 120 s timeout), `dist/photo-tool/web/index.html` exists and references a script under `assets/`.
- [ ] **Step 2: Run** `npx vitest run shared/tests/boundaries.test.ts`.
  - Expected: FAIL, because `photo-tool/` does not exist.
- [ ] **Step 3: Do the moves and edits** listed under Files.
- [ ] **Step 4: Run** `npm run typecheck`, `npx vitest run`, `npx playwright test --project=photo-tool`, then `npx playwright test --project=editor`.
  - Expected: all pass. Unit tests 1003 + 2 new, 4 skipped.
- [ ] **Step 5: Run** `npm run desktop:build`, then start it with temp data folders:
  ```
  PHOTOBOOK_GALLERY_DATA_DIR=<tmp>/g PHOTOBOOK_GALLERY_PROFILE_DIR=<tmp>/gp electron dist/desktop/app --gallery
  ```
  - Expected: the log shows "server ready" and no failed load. Close it.
- [ ] **Step 6: Commit** `refactor: move the gallery into photo-tool/ with its own page build`.

### Task 4: `photobook-editor/` (server, page, core, tests)

**Files:**
- Move:
  - `src/server/**` → `photobook-editor/server/**`;
  - `src/web/**` → `photobook-editor/web/**`, including `backend/`, `public/` and `demo/`;
  - `src/core/**` → `photobook-editor/core/**`;
  - `src/shared/{flipbookViewer,pdfWriter}.ts` → `photobook-editor/shared/`;
  - all remaining `tests/*.test.ts` → `photobook-editor/tests/`, and `tests/e2e/{milestone,perf,draft-stars}.spec.ts` → `photobook-editor/tests/e2e/`;
  - any test file left that imports both programs is split into one file per program.
- Move `vite.config.ts` to `photobook-editor/vite.config.ts`:
  - `root: photobook-editor/web`, `build.outDir: dist/photobook-editor/web`;
  - `publicDir: false`, since the pages mode is deleted in Task 10. Until then, keep `--mode pages` working with `publicDir: 'public'` relative to root, as today.
- Modify `photobook-editor/server/main.ts`: default data `./data/photobook-editor`, default fallback `./data/photoinfo-shared` (env `PHOTOBOOK_DATA_DIR`, `PHOTOINFO_FALLBACK_DIR`). It serves `webDir('photobook-editor')`.
- Modify the photoinfo fallback: the editor's server today derives it as `<dataDir>/photoinfo`. Now it takes `photoInfoFallbackDir` as an option, like Photo Tool's.
- `package.json` scripts:
  - `dev` → `dev:editor`;
  - `build` → `build:editor` (`tsc --noEmit && vite build --config photobook-editor/vite.config.ts`);
  - `start` → `tsx photobook-editor/server/main.ts --production`;
  - `test` stays `vitest run`; `typecheck` stays;
  - add `e2e:editor`.
  - `playwright.config.ts`: the `editor` project's `testDir` is `photobook-editor/tests/e2e`, and its webServer uses the new paths.
- Modify `.claude/launch.json`: two configurations, `photo-tool` (`npm run dev:photo-tool`, port 5175) and `photobook-editor` (`npm run dev:editor`, port 5173).
- `scripts/*.ts` imports follow the moves.

**Interfaces:**
- Consumes: `webDir(program)` (Task 3).
- Produces: `dist/photobook-editor/web/index.html`. `src/` now holds no files.

- [ ] **Step 1: Add boundary rules.**
  - `{ from: 'photobook-editor', mayImport: ['shared'] }` gives `[]`.
  - **"src/ is empty":** no file under `src/`.
- [ ] **Step 2: Run** `npx vitest run shared/tests/boundaries.test.ts`.
  - Expected: FAIL.
- [ ] **Step 3: Do the moves and edits.** Then delete the empty `src/`.
- [ ] **Step 4: Run** `npm run typecheck`, `npx vitest run`, `npx playwright test` (both projects), then `npm run fixtures && npx tsx scripts/draft-from-folder.ts --help` (or another `scripts/` entry) to make sure the scripts still resolve.
  - Expected: all pass. Unit tests 1005 + 2 new, 4 skipped.
- [ ] **Step 5: Commit** `refactor: move the editor into photobook-editor/`.

### Task 5: The shared desktop shell, and moving old data folders

**Files:**
- Create:
  - `shared/electron/runDesktopApp.ts`: the program-neutral body of today's `electron/main.ts`, from logging through single instance;
  - `shared/electron/serverHost.ts`;
  - `shared/electron/config.ts`;
  - `shared/electron/dataFolders.ts`.
- Move with `git mv`:
  - `electron/netGuard.ts` → `shared/electron/netGuard.ts`;
  - the shared parts of `electron/selfTest.ts` (`Step`, `SelfTestContext`, `SELF_TEST_CONTROL_URLS`, the network and page checks) → `shared/electron/selfTest.ts`.
- `electron/config.ts`:
  - `parseSelfTest`, `selfTestOverlap`, `restoreWindow`, `describeFailure`, `describeAbout`, `LICENCE_FILE`, `NOTICES_FILE`, `NOTICES_BUTTON`, `MIN_WINDOW`, `DEFAULT_WINDOW`, `taggingWorkerPath` and `dataLayout` move to `shared/electron/config.ts`. Drop the `mode` parameters: the program name says which.
  - `parseMode`, `galleryLaunchCommand`, `galleryEnv`, `AppMode`, `GALLERY_PRODUCT_NAME` and `GALLERY_APP_ID` are deleted in Tasks 6 and 7, not here.
- Tests:
  - `shared/tests/data-folders.test.ts`;
  - `shared/tests/desktop-config.test.ts` (today's config tests from `tests/electron-shell.test.ts`, moved and adjusted).

**Interfaces:**
- Produces (Tasks 6 to 8 use these):
  ```ts
  // shared/electron/config.ts
  export interface ProgramNames { productName: string; envPrefix: 'PHOTOBOOK' | 'PHOTO_TOOL'; oldProductName: string }
  export function dataLayout(o: { appData: string; productName: string; packaged: boolean; env: Record<string, string | undefined>; envPrefix: string; selfTestOut?: string }): { dataDir: string; profileDir: string; root: string }
  export function photoInfoFallbackDir(o: { appData: string; packaged: boolean; env: Record<string, string | undefined>; selfTestOut?: string }): string
  //   env.PHOTOINFO_FALLBACK_DIR → resolved; selfTestOut → <out>/photoinfo-shared; else <appData>/Photo Tools Shared[ Dev]/photoinfo
  export function launchFolder(argv: readonly string[], defaultApp: boolean): string | null
  //   argv[1..] when packaged, argv[2..] when defaultApp; skips --self-test/--self-test-out and their values and any --flag; first remaining arg or null

  // shared/electron/dataFolders.ts
  export class CarryOverError extends Error { constructor(public from: string, public to: string, cause: unknown) }
  export function carryOver(from: string, to: string, rename?: (a: string, b: string) => void): 'moved' | 'nothing-to-move' | 'already-there'
  //   to exists → 'already-there' (from untouched); from missing → 'nothing-to-move'; else mkdir parent of to, rename(from, to) → 'moved'; rename throws → CarryOverError
  export function carryOverAll(o: { appData: string; packaged: boolean; oldProductName: string; productName: string }): { data: ReturnType<typeof carryOver>; photoinfo: ReturnType<typeof carryOver> }
  //   1) <appData>/<old>[ Dev] → <appData>/<new>[ Dev]
  //   2) photoinfo: the first existing of <appData>/Photobook Studio[ Dev]/data/photoinfo and <appData>/Photobook Editor[ Dev]/data/photoinfo → photoInfoFallbackDir(...)

  // shared/electron/runDesktopApp.ts
  export interface DesktopProgram {
    names: ProgramNames;
    appUserModelId: string;
    description: string;
    serverHostFile: string;                       // 'server-host.cjs' beside main.cjs
    page(base: string): string;                   // URL the window loads
    hostResolverRules: string;                    // from mapTiles for Photo Tool; the editor's offline rule
    requestAllowed(url: string, method: string, guard: GuardOptions): boolean;
    sendHeaders?(session: Electron.Session, version: () => string): void;   // Photo Tool's tile headers
    fileMenu(ctx: ProgramContext): MenuItemConstructorOptions[];
    registerIpc(ctx: ProgramContext): void;
    startMessage(ctx: ProgramContext): Partial<StartMessage>;               // e.g. photoInfoFallbackDir
    singleInstanceData?(): unknown;
    onSecondInstance?(data: unknown): void;
    confirmQuit?(): boolean;
    selfTest(ctx: SelfTestContext & ProgramContext): Promise<Record<string, Step>>;
    prepareSelfTest?(ctx: ProgramContext): Promise<void>;
    onWindow?(win: BrowserWindow): void;
  }
  export interface ProgramContext { layout: { dataDir: string; profileDir: string }; photoInfoFallbackDir: string; selfTest: SelfTestArgs | null; window(): BrowserWindow | null; serverPort(): number; fromApp(e: { senderFrame: Electron.WebFrameMain | null }): boolean; log(...a: unknown[]): void; resourceRoot(): string | undefined }
  export function runDesktopApp(program: DesktopProgram): void
  //   carryOverAll runs before app.setPath('userData'); a CarryOverError → dialog "<new name> can't start yet" saying to close <old name> (and that nothing was changed), then app.exit(1)

  // shared/electron/serverHost.ts
  export interface StartMessage { type: 'start'; dataDir: string; photoInfoFallbackDir: string; port: number; resourceRoot?: string; devWebUrl?: string }
  export function runServerHost(create: (msg: StartMessage, post: (m: HostReply) => void) => Promise<{ app: Express; close: () => void }>, checkResources: (root: string) => void): void
  ```

- [ ] **Step 1: Write the failing tests.**
  - `shared/tests/data-folders.test.ts`, all on `mkdtemp` folders:
    - **"moves the old folder when the new one is missing":** returns `'moved'`; the new folder holds `data/x.txt`; the old one is gone.
    - **"leaves both alone when both exist":** returns `'already-there'`; the contents of both are unchanged.
    - **"nothing to move":** returns `'nothing-to-move'`, and the new folder is not created.
    - **"refuses when the old folder is in use":** a `rename` that throws `EBUSY` gives a `CarryOverError` whose `from`/`to` are the two paths; the old folder is intact and the new one does not exist.
    - **"carryOverAll moves the editor's photoinfo to the shared fallback":** old `Photobook Studio Dev/data/photoinfo/a.json` ends up at `Photo Tools Shared Dev/photoinfo/a.json`, and `Photobook Editor Dev/data` exists without `photoinfo`. Run it once with editor names and once with Photo Tool names, in both orders; the end state is the same.
  - `shared/tests/desktop-config.test.ts`:
    - **`launchFolder`:**
      - `['C:/PT/Photo Tool.exe', 'D:/pics']` (packaged) → `'D:/pics'`;
      - `['electron', 'dist/photo-tool/dev', 'D:/pics']` (defaultApp) → `'D:/pics'`;
      - `['exe', '--self-test', 'D:/fx', '--self-test-out', 'D:/o']` → `null`;
      - `['exe', '--some-flag', 'D:/pics']` → `'D:/pics'`;
      - `['exe']` → `null`.
    - **`photoInfoFallbackDir`:**
      - packaged → `<appData>/Photo Tools Shared/photoinfo`;
      - dev → `<appData>/Photo Tools Shared Dev/photoinfo`;
      - `PHOTOINFO_FALLBACK_DIR` wins;
      - with a self-test out folder → `<out>/photoinfo-shared`;
      - **"is the same for both programs":** called the same way, it gives one path whether the caller is the editor or Photo Tool (it takes no program argument).
    - **`dataLayout` with `envPrefix: 'PHOTO_TOOL'`** reads `PHOTO_TOOL_DATA_DIR` and ignores `PHOTOBOOK_DATA_DIR`.
    - The existing `restoreWindow`, `describeFailure`, `describeAbout`, `parseSelfTest` and `selfTestOverlap` tests move here and pass without `mode`.
- [ ] **Step 2: Run** `npx vitest run shared/tests/data-folders.test.ts shared/tests/desktop-config.test.ts`.
  - Expected: FAIL, because the modules do not exist.
- [ ] **Step 3: Implement** the modules above. `runDesktopApp` is today's `electron/main.ts` with every `isGallery` branch replaced by a `DesktopProgram` hook. `runServerHost` is today's `electron/server-host.ts` with `createServer` and `checkResources` passed in. `electron/main.ts` and `electron/server-host.ts` stay for now, built on these modules with a temporary `--gallery` switch between two `DesktopProgram` objects, so the desktop build still works.
- [ ] **Step 4: Run** `npm run typecheck`, `npx vitest run`, then `npm run desktop:build`.
  - Expected: all pass. The editor and `--gallery` both start with temp data folders (as in Task 3 Step 5).
- [ ] **Step 5: Commit** `refactor: shared desktop shell and data-folder carry-over`.

### Task 6: Photo Tool as its own desktop program and installer

**Files:**
- Create:
  - `photo-tool/electron/main.ts`: `runDesktopApp(photoTool)`, where `photoTool: DesktopProgram` holds today's gallery branches: folders, drag, file actions, edit actions, map consent, tile headers, `galleryPage`, `launchFolder` as the start folder, and the gallery self-test.
  - `photo-tool/electron/preload.ts`: today's preload without `openGallery` and the editor-only functions (`openFile` and `showInFolder` for exports, if Photo Tool's page never calls them; check with grep).
  - `photo-tool/electron/server-host.ts`: `runServerHost(createGalleryApp…, checkPhotoToolResources)`.
- Move with `git mv`:
  - `electron/{gallery,drag,editActions,fileActions,mapTiles}.ts` → `photo-tool/electron/`;
  - the gallery parts of `electron/selfTest.ts` (`prepareGalleryPhotos`, `runGallerySelfTest`) → `photo-tool/electron/selfTest.ts`.
  - `launchGallery` and `galleryLaunchCommand` are deleted.
- Create:
  - `photo-tool/product.json`: `{ "productName": "Photo Tool", "appId": "app.phototool.desktop", "description": <today's GALLERY_DESCRIPTION>, "maintainer": "Photo Tool <photo-tool@localhost>", "repository": "github:funvill/photo-tool" }`;
  - `photo-tool/electron-builder.config.cjs`: today's config with Photo Tool's names and folders. It has `asarUnpack: ['node_modules/**', 'tagging-worker.cjs']`, no `installer.nsh` gallery macros, Linux `desktop.entry.Name: 'Photo Tool'`, and no `fpm` second launcher.
- `shared/desktop/desktopApi.ts`: `openGallery` is removed from the type. Each program's preload implements only its part, as `Partial` plus required keys. The builder may split the type into `EditorDesktopApi` and `PhotoToolDesktopApi` sharing a base; `shared/web/desktop.ts` stays typed on the base.
- Modify `scripts/desktop/build.mjs`:
  - `--program photo-tool|photobook-editor` is required, and a missing or unknown value throws.
  - It reads `<program>/product.json` and `<program>/electron/*.ts`, and writes `dist/<program>/desktop/{app,dev,resources,icon.png,icons}`.
  - The generated `package.json` `name` is `photo-tool` or `photobook-editor`, and `desktopName` is `<name>.desktop`.
  - Per program:
    - `EXTERNAL` is `['sharp', '@huggingface/transformers']` for Photo Tool and `['sharp', 'pdfkit', 'fontkit']` for the editor.
    - The tagging worker is built only for Photo Tool.
    - The onnxruntime binary check runs only for Photo Tool.
  - The Task 3 bridge (gallery.html in the editor's resources) is removed.
- `scripts/desktop/dev.mjs` and `ensure-electron.mjs` take `--program` too. Delete the `--gallery` handling.
- `scripts/collect-resources.ts`: `--program <name>` copies that program's built page into `<out>/web` and only the resources it needs. The test below fixes Photo Tool's list; the editor's is today's list.
- `scripts/make-notices.ts` takes the runtime-module list of the program being built, so each `THIRD-PARTY-NOTICES.txt` lists only what that installer carries.
- `scripts/launcher/make-icon.ts <out> --program <name>`: Photo Tool's icon is visibly different from the editor's, using a different background colour and glyph. The drawing is the builder's call.
- `package.json` scripts:
  - `desktop:build:photo-tool`: `npm run build:photo-tool && node scripts/desktop/ensure-electron.mjs && node scripts/desktop/build.mjs --program photo-tool`;
  - `start:photo-tool`: `electron dist/photo-tool/desktop/app`;
  - `dev:desktop:photo-tool`;
  - `dist:photo-tool`: `npm run desktop:build:photo-tool && electron-builder --config photo-tool/electron-builder.config.cjs --publish never`;
  - `dist:dir:photo-tool`.
- Tests: `photo-tool/tests/photo-tool-shell.test.ts` (the gallery parts of `tests/electron-shell.test.ts`, moved and changed).

**Interfaces:**
- Consumes: `runDesktopApp`, `DesktopProgram`, `runServerHost`, `launchFolder`, `photoInfoFallbackDir`, `taggingWorkerPath` (Task 5); `webDir('photo-tool')` (Task 3).
- Produces: `dist/photo-tool/desktop/app` and `dist/installer/Photo Tool Setup <v>.exe` (Windows), or `photo-tool-<v>-x86_64.AppImage` / `photo-tool_<v>_amd64.deb` (Linux). The installer output folder is `dist/installer/photo-tool`.
- `checkPhotoToolResources(root: string): void` throws `App files are missing: …`.

- [ ] **Step 1: Write the failing tests** `photo-tool/tests/photo-tool-shell.test.ts`.
  - **"builder config":** the config's `productName` is `'Photo Tool'` (`'photo-tool'` when `process.platform === 'linux'`); `appId` is `'app.phototool.desktop'`; `asarUnpack` matches `/asarUnpack: \[[^\]]*'node_modules\/\*\*'/`; there is no `include: 'electron/installer.nsh'` and no `fpm`; `directories.app` is `'dist/photo-tool/desktop/app'`; `directories.output` is `'dist/installer/photo-tool'`.
  - **"checkPhotoToolResources":** on a temp folder holding exactly what the Photo Tool server reads (`web/index.html`, the files `shared/server/resources.ts` gives for the functions Photo Tool's server calls — find them with `grep -rn "fontFile\|worldAtlasFile\|libheifFile\|pdfiumDir" photo-tool shared`), it does not throw. Deleting any one of them makes it throw with that path in the message. `pdfium` is not required.
  - **"main has no editor":** the closure of `photo-tool/electron/main.ts`, `photo-tool/electron/server-host.ts` and `photo-tool/electron/preload.ts` contains no `photobook-editor/` file. The boundary rule from Task 3 already covers this, so this is an assertion on `importClosure`, as a guard on the entry points.
  - **"no --gallery":** `grep` for `'--gallery'` in `photo-tool/` and `shared/` finds nothing.
  - **"Photo Tool's preload has no openGallery":** `photo-tool/electron/preload.ts` text does not contain `openGallery`.
- [ ] **Step 2: Run** `npx vitest run photo-tool/tests/photo-tool-shell.test.ts`.
  - Expected: FAIL.
- [ ] **Step 3: Implement** everything listed under Files.
- [ ] **Step 4: Run** `npm run typecheck` and `npx vitest run`, then `npm run dist:photo-tool` (on Windows).
  - Expected: all pass, and the `.exe` exists.
- [ ] **Step 5: Self-test the unpacked build** with temp folders:
  ```
  $env:PHOTO_TOOL_DATA_DIR="$env:TEMP\pt-st\data"; & "dist\installer\photo-tool\win-unpacked\Photo Tool.exe" --self-test "$PWD\fixtures\generated\trip" --self-test-out "$env:TEMP\pt-st\out"
  ```
  - Expected: exit code 0. `result.json` has `"ok": true` and `app.name` = `"Photo Tool"`.
- [ ] **Step 6: Commit** `feat: Photo Tool is its own desktop program and installer`.

### Task 7: Photobook Editor as its own desktop program and installer

**Files:**
- Create:
  - `photobook-editor/electron/main.ts`: `runDesktopApp(editor)`, with today's editor branches: export open and show-in-folder, the `restart` message, the editor self-test, and no "Open Gallery".
  - `photobook-editor/electron/preload.ts`;
  - `photobook-editor/electron/server-host.ts`: today's checks, plus `photoInfoFallbackDir` passed to `createApp`.
- Move with `git mv`:
  - `electron/installer.nsh` → `photobook-editor/electron/installer.nsh`, without the `addGalleryShortcuts` and `removeGalleryShortcuts` macros and their calls;
  - the editor parts of `electron/selfTest.ts` → `photobook-editor/electron/selfTest.ts`.
- Delete `electron/linux/photobook-gallery.desktop`.
- Create:
  - `photobook-editor/product.json`: `{ "productName": "Photobook Editor", "appId": "app.photobookeditor.desktop", "description": <today's description>, "maintainer": "Photobook Editor <photobook-editor@localhost>", "repository": "github:funvill/photo-tool" }`;
  - `photobook-editor/electron-builder.config.cjs`: today's config with these names; `directories.app` `dist/photobook-editor/desktop/app`; output `dist/installer/photobook-editor`; no onnxruntime trimming; no `fpm`.
- Remove "Open gallery" from the editor's page: find the call to `desktop.openGallery` and its button or menu item under `photobook-editor/web` and remove them.
- Delete `electron/` (it is empty now) and the temporary `--gallery` switch from Task 5.
- Delete the root `electron-builder.config.cjs`.
- `package.json` scripts:
  - `desktop:build:editor`, `start:editor`, `dev:desktop:editor`, `dist:editor`, `dist:dir:editor`;
  - `desktop:build`, `start:desktop`, `dev:desktop`, `dist` and `dist:dir` are deleted. `dist:all` runs both `dist:*`.
- Tests: `photobook-editor/tests/editor-shell.test.ts` (the editor parts of `tests/electron-shell.test.ts`). `tests/electron-shell.test.ts` is deleted once both halves have moved. `desktop-docs.test.ts` is updated in Task 10.

**Interfaces:**
- Consumes: Task 5's shell; Task 6's `build.mjs --program`.
- Produces: `dist/installer/photobook-editor/Photobook Editor Setup <v>.exe` and the Linux deb and AppImage named `photobook-editor`.

- [ ] **Step 1: Write the failing tests** `photobook-editor/tests/editor-shell.test.ts`.
  - **"builder config":** `productName` is `'Photobook Editor'` (`'photobook-editor'` on Linux); `appId` is `'app.photobookeditor.desktop'`; `nsis.include` is `'photobook-editor/electron/installer.nsh'`.
  - **"installer.nsh has no gallery shortcuts":** its text contains neither `Gallery` nor `--gallery`.
  - **"no Open Gallery":** a grep for `openGallery`, `open-gallery` and `Open &Gallery` in `photobook-editor/`, `shared/` and `photo-tool/` finds nothing.
  - **"the editor carries no onnxruntime":** the build list for the editor (export a `runtimeModuleNames(program)` from `build.mjs`, or check `dist/photobook-editor/desktop/app/node_modules` after a build in a `beforeAll`) contains no `onnxruntime-*` or `@huggingface/*`.
  - Boundary test **"electron/ is gone":** the folder `electron/` does not exist.
- [ ] **Step 2: Run** `npx vitest run photobook-editor/tests/editor-shell.test.ts shared/tests/boundaries.test.ts`.
  - Expected: FAIL.
- [ ] **Step 3: Implement** everything listed under Files.
- [ ] **Step 4: Run** `npm run typecheck`, `npx vitest run`, `npx playwright test`, then `npm run dist:editor`.
  - Expected: all pass, and the `.exe` exists.
- [ ] **Step 5: Self-test the unpacked editor** as in Task 6 Step 5, with `PHOTOBOOK_DATA_DIR` set to a temp folder.
  - Expected: `"ok": true` and `app.name` = `"Photobook Editor"`.
- [ ] **Step 6: Commit** `feat: Photobook Editor is its own desktop program and installer; drop Open Gallery`.

### Task 8: Running from source, moving `./data` over

**Files:**
- Create `shared/server/devData.ts`:
  ```ts
  export function devDataLayout(root: string): { editor: string; photoTool: string; photoinfo: string }   // <root>/data/{photobook-editor,photo-tool,photoinfo-shared}
  export function carryOverDevData(root: string, rename?: (a: string, b: string) => void): { moved: string[] }
  //   if <root>/data/photobook-editor exists → nothing (moved: []).
  //   else: <root>/data/gallery → photo-tool; <root>/data/photoinfo → photoinfo-shared;
  //         every other entry directly under <root>/data (except the three new names) → <root>/data/photobook-editor/<entry>.
  //   Any rename failing → throws CarryOverError (Task 5) naming the entry; entries already moved stay moved, and a second run finishes the rest.
  ```
- Create `scripts/carry-over-dev-data.ts`, which calls `carryOverDevData(projectRoot)` and prints what moved.
- Each program's server `main.ts` (`photo-tool/server/main.ts`, `photobook-editor/server/main.ts`) calls `carryOverDevData` before reading its data folder. This happens only when it uses the default `./data` paths, meaning neither `${PREFIX}_DATA_DIR` nor `PHOTOINFO_FALLBACK_DIR` is set. Both pass `PHOTOINFO_FALLBACK_DIR ?? devDataLayout(root).photoinfo` to their app.
- `scripts/desktop/dev.mjs` runs `tsx scripts/carry-over-dev-data.ts` before starting, unless the data env variables are set. It sets `${PREFIX}_DATA_DIR`, `${PREFIX}_PROFILE_DIR` (`./data/<program>-browser`) and `PHOTOINFO_FALLBACK_DIR` to the dev layout.
- Test: `shared/tests/dev-data.test.ts`

**Interfaces:**
- Consumes: `CarryOverError` (Task 5).

- [ ] **Step 1: Write the failing tests** on a temp project root:
  - **"splits the old layout":** start with `data/{photobook.db, exports/x.pdf, gallery/catalog.db, photoinfo/a.json}`. After the call: `data/photobook-editor/{photobook.db, exports/x.pdf}`, `data/photo-tool/catalog.db` and `data/photoinfo-shared/a.json` exist, and nothing else is left at the top of `data/`.
  - **"runs once":** a second call returns `{ moved: [] }` and changes nothing.
  - **"no old data":** on an empty `data/`, nothing is created.
  - **"half done":** a rename that throws on `photoinfo` throws `CarryOverError` naming `data/photoinfo`. A second call with a working `rename` finishes, with the same end state as "splits the old layout".
  - **"both servers get the same fallback":** importing `photo-tool/server/main.ts` and `photobook-editor/server/main.ts` is too heavy for a unit test. Instead, export from each `main.ts` a pure `resolveDirs(env, root)` that returns `{ dataDir, photoInfoFallbackDir }`, and assert that both return the same `photoInfoFallbackDir` for the same env and root.
- [ ] **Step 2: Run** `npx vitest run shared/tests/dev-data.test.ts`.
  - Expected: FAIL.
- [ ] **Step 3: Implement** the above.
- [ ] **Step 4: Run** `npm run typecheck`, `npx vitest run`, then `npx playwright test`.
  - Expected: all pass. Playwright sets the data env variables, so no carry-over runs.
- [ ] **Step 5: Commit** `feat: running from source splits ./data per program and carries the old layout over`.

> Do **not** run `npm run dev:*` against the real `./data` to try this out. The unit tests are the proof. Steven's own first dev run does the real move.

### Task 9: CI for two programs

**Files:**
- Modify `.github/workflows/desktop.yml`. Windows and Linux each get a matrix over `program: [photo-tool, photobook-editor]`, and each job:
  - runs `npm run dist:${{ matrix.program }}`;
  - uploads `dist/installer/${{ matrix.program }}/*.{exe,deb,AppImage}` as artifact `${{ matrix.program }}-<os>-x64`;
  - self-tests the unpacked build on Windows, and the installed `.deb` (command `${{ matrix.program }}`) and the AppImage on Linux. Data env variables: `PHOTOBOOK_DATA_DIR` for the editor, `PHOTO_TOOL_DATA_DIR` for Photo Tool. `PHOTOINFO_FALLBACK_DIR` is set to `$RUNNER_TEMP/...` in every self-test step;
  - keeps the `GLib-GObject-CRITICAL` check on Linux.
- Modify `photo-tool/electron/selfTest.ts`: add a step **`taggingWorkerLoads`**. It starts the tagging worker from `taggingWorkerPath(__dirname)` with no model and asks it for its runtime. The step is ok when the worker answers that `onnxruntime-node` loaded (add a `{ type: 'ping' }` message to the worker that replies `{ type: 'pong', ort: string }`, the onnxruntime version), within 30 s, without any network request.
- Modify `.github/workflows/test.yml`: delete the `npx vite build --mode pages` step. `npm run build` becomes `npm run build:editor && npm run build:photo-tool`.
- Tests: `photo-tool/tests/tagging-worker-ping.test.ts`.

**Interfaces:**
- Consumes: the worker in `photo-tool/server/tagging/worker.ts`, and `workerBackend` in `backend.ts`.
- Produces: the self-test step `taggingWorkerLoads: { ok: boolean; ort?: string; error?: string }`.

- [ ] **Step 1: Write the failing test** `tagging-worker-ping.test.ts`.
  - **"the worker answers a ping with the onnxruntime version":** start the worker from source the way `gallery-tagger-backend.test.ts` does, send `{ type: 'ping' }`, and expect `{ type: 'pong', ort: /^\d+\.\d+\.\d+/ }` within 30 s.
- [ ] **Step 2: Run** it.
  - Expected: FAIL, because the worker doesn't know the `ping` message.
- [ ] **Step 3: Implement** the ping, the self-test step and the two workflow files.
- [ ] **Step 4: Run** `npx vitest run`. Then run the Photo Tool self-test from Task 6 Step 5 again.
  - Expected: `steps.taggingWorkerLoads.ok` is `true`.
- [ ] **Step 5: Validate the workflow files** with `npx --yes @action-validator/cli .github/workflows/desktop.yml .github/workflows/test.yml`, if it is available offline; otherwise read them through once more.
  - CI itself runs after the push in Task 11.
- [ ] **Step 6: Commit** `ci: build, install and self-test both programs on Windows and Linux`.

### Task 10: Cut from upstream, drop the web version, docs

**Files:**
- Delete:
  - `.github/workflows/pages.yml`;
  - `docs/WEB_VERSION.md`;
  - the `build:pages` and `preview:pages` scripts;
  - `--mode pages` handling in `photobook-editor/vite.config.ts` (the `pages` branch, the `base`, and `publicDir`). The in-browser backend code stays.
- `git remote remove upstream`. This is local git config, not a file; record it in the ledger.
- Root `package.json`: `"name": "photo-tools"`, and `repository` pointing at `github:funvill/photo-tool` if present. `package-lock.json` follows via `npm install --package-lock-only`.
- README:
  - The root `README.md` is short: the two programs, how to build, run, test and package each (the new commands), the data folders and the carry-over, and a note to uninstall the old "Photobook Studio" by hand.
  - `photo-tool/README.md` gets today's "Photobook Gallery" section, the `photoinfo.json` section, and the tagging parts, with "Photobook Gallery" changed to "Photo Tool".
  - `photobook-editor/README.md` gets the rest, without "Use it in your browser".
- Every mention of `jkw2lo` or `photobook_studio` outside `docs/superpowers/` (history) and `docs/{plan,research,handoff,electron-plan}.md` (history) is removed or pointed at this repository. That includes code comments, `photobook-editor/web/public/demo-welcome.js` (dead code, but it must not point upstream) and `docs/ARCHITECTURE.md`.
- `photobook-editor/tests/desktop-docs.test.ts`, today's `tests/desktop-docs.test.ts`, is updated for the new READMEs and commands.
- Test: `shared/tests/no-upstream.test.ts`.

- [ ] **Step 1: Write the failing test** `no-upstream.test.ts`.
  - `git grep -n -I -e jkw2lo -e photobook_studio -- . ':!docs/superpowers' ':!docs/plan.md' ':!docs/research.md' ':!docs/handoff.md' ':!docs/electron-plan.md' ':!package-lock.json'` finds nothing (exit code 1).
  - `.github/workflows/pages.yml` does not exist.
  - The root `package.json` has no `build:pages` script.
- [ ] **Step 2: Run** it.
  - Expected: FAIL.
- [ ] **Step 3: Make the changes** listed under Files.
- [ ] **Step 4: Run** `npm run typecheck`, `npx vitest run`, then `git remote -v`.
  - Expected: all pass, and only `origin` is listed.
- [ ] **Step 5: Commit** `chore: cut from upstream, drop the web version, split the README`.

### Task 11: Whole check, push

- [ ] **Step 1: Boundary test, final form.**
  - The rules: `shared` → `[]`; `photo-tool` → `['shared']`; `photobook-editor` → `['shared']`.
  - `src/` and `electron/` don't exist.
  - `scripts/` may import any folder.
  - Run `npx vitest run shared/tests/boundaries.test.ts`.
  - Expected: PASS.
- [ ] **Step 2: Run everything:**
  - `npm run typecheck`
  - `npx vitest run`
  - `npx playwright test`
  - `npm run dist:photo-tool`
  - `npm run dist:editor`
  - Expected: all green. The unit-test count is reported against the 998 baseline: the tests added here, minus the `--gallery` and Open Gallery tests replaced by Tasks 5 to 7. Each removed test is named in the ledger.
- [ ] **Step 3: Contents check of both installers' unpacked folders.**
  - `dist/installer/photo-tool/win-unpacked/resources/app.asar` (list it with `npx asar list`) has no file from the editor's bundle: its `server-host.cjs` doesn't contain `createApp(`, and there is no `pdfkit`.
  - The editor's has no `tagging-worker.cjs` and no `onnxruntime`.
  - Record the two installer sizes in the ledger.
- [ ] **Step 4: Old-folder carry-over on this machine, with copies.**
  - Copy `%APPDATA%\Photobook Gallery Dev` and `Photobook Studio Dev` (if present) into a temp `appData`. Run `carryOverAll` against the copy from a tsx one-liner, for both programs.
  - Check that the new folders hold the same file count as the old ones did.
  - Never run it against the real `%APPDATA%`.
- [ ] **Step 5: Push the branch.** `gh auth switch -u funvill`, then `git push -u origin split-programs`, then `gh auth switch -u ssmethurst`.
  - Expected: the CI `Tests` and `Desktop installers` workflows start for the branch. Their results go to the final message. They are not waited on in a loop.
- [ ] **Step 6: Commit** any last fixes (version bump each time).

---

## Notes for the executor

- **Known CI failures on `main` before this work** (run 45647278443):
  - macOS fails `editing.test.ts` › "exports a poster as JPEG and PNG…" and `photo-edit-render.test.ts` › "keeps EXIF with an upright orientation";
  - Windows times out `gallery-tagging-queue.test.ts` › "a big folder…" (38 s).
  - None fails locally. They are not part of this plan. Do not count them as regressions; report them in the final message.
- **If a module turns out to be used by both programs** after a move (typecheck errors), it goes to `shared/` under the same rule. Ledger it as a ruling.
