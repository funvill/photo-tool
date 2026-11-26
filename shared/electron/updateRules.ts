// Checking GitHub for a new version, the part that needs no Electron: the settings file, the
// once-a-day rule for the check at start, where a program's releases live, which errors only mean
// "nothing published yet", the words the user reads, and the hosts the updater may look up.
// The controller that drives electron-updater is updates.ts. Unit-tested in shared/tests/update-rules.test.ts.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The only names the updater looks up: GitHub's site and API, and the two hosts a release download
 * redirects to. Each program's host-resolver-rules let these through (see netGuard.hostResolverRules);
 * the window's own request guard does not change.
 */
export const UPDATE_HOSTS: readonly string[] = ['github.com', 'api.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];

/** GitHub's site: the release pages (and the feedback page, config.feedbackUrl) are under it. Written down here only. */
export const GITHUB_ORIGIN = 'https://github.com';

/** The check at start runs at most once in this long (24 hours). */
export const CHECK_INTERVAL_MS = 86_400_000;

/** <profileDir>/updates.json: is the daily check on, and when did the last one finish. */
export interface UpdateSettings {
  auto: boolean;
  /** Milliseconds since 1970 of the last check that got an answer, or null for never. */
  lastCheck: number | null;
}

const DEFAULTS: UpdateSettings = { auto: true, lastCheck: null };

/** The settings in `file`. A missing, unreadable or hand-edited file gives the defaults (field by field); it never throws. */
export function readUpdateSettings(file: string): UpdateSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { ...DEFAULTS };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULTS };
  const { auto, lastCheck } = raw as Record<string, unknown>;
  return {
    auto: typeof auto === 'boolean' ? auto : DEFAULTS.auto,
    lastCheck: typeof lastCheck === 'number' && Number.isFinite(lastCheck) ? lastCheck : DEFAULTS.lastCheck,
  };
}

/** Save the settings: written to `<file>.tmp` and renamed, so a crash never leaves half a file. Throws when it cannot be written. */
export function writeUpdateSettings(file: string, s: UpdateSettings): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ auto: s.auto, lastCheck: s.lastCheck }, null, 2) + '\n');
  renameSync(tmp, file);
}

/**
 * Does the quiet check at start run? Only in the installed program, never in a self-test or when
 * <PREFIX>_NO_UPDATE_CHECK is set, only with the setting on, and only when the last check was at least
 * a day ago (or never, or "in the future" because the clock was turned back).
 */
export function shouldCheckAtStart(o: { packaged: boolean; selfTest: boolean; disabledByEnv: boolean; settings: UpdateSettings; now: number }): boolean {
  if (!o.packaged || o.selfTest || o.disabledByEnv || !o.settings.auto) return false;
  const last = o.settings.lastCheck;
  if (last === null || last > o.now) return true;
  return o.now - last >= CHECK_INTERVAL_MS;
}

/** Owner and repo from product.json's repository ("github:owner/repo"), or null for anything else. */
export function githubRepo(repository: string | undefined): { owner: string; repo: string } | null {
  const m = /^github:([^/\s]+)\/([^/\s]+)$/.exec(repository ?? '');
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/** The release page of `version` on GitHub, opened by Release notes. */
export function releasePage(repo: { owner: string; repo: string }, version: string): string {
  return `${GITHUB_ORIGIN}/${repo.owner}/${repo.repo}/releases/tag/v${version}`;
}

/** The newest published release, for a program that cannot install an update by itself. */
export function latestReleasePage(repo: { owner: string; repo: string }): string {
  return `${GITHUB_ORIGIN}/${repo.owner}/${repo.repo}/releases/latest`;
}

/**
 * Does this error only say that nothing is published yet? Until the first release is published (and
 * while only drafts exist) GitHub has no entries, or answers 404 for the latest release; that is
 * "up to date", never an error box. Decided on electron-updater's error code and HTTP status, not on
 * any "404" in the text. A release without this program's update file (<channel>.yml) is a failure:
 * the release is broken, and saying "up to date" would hide that.
 */
export function isNoRelease(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const { code, statusCode } = e as Error & { code?: unknown; statusCode?: unknown };
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') return false;
  if (code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' || code === 'ERR_XML_MISSED_ELEMENT') return /^No published versions on GitHub/.test(e.message);
  // The releases feed itself.
  if (e.name === 'HttpError') return statusCode === 404;
  // releases/latest, which electron-updater rewraps (as ERR_UPDATER_INVALID_RELEASE_FEED): only a 404 there.
  if (code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' || code === 'ERR_UPDATER_INVALID_RELEASE_FEED') {
    return /Unable to find latest version on GitHub \([^)]*\), please ensure a production release exists: HttpError: 404\b/.test(e.message);
  }
  return false;
}

/**
 * Which updater: on Linux the AppImage sets APPIMAGE to its own path, and that decides. electron-updater
 * itself picks DebUpdater whenever resources/package-type says deb, and the AppImage may carry that file
 * (both Linux packages are built from one folder), so an AppImage would otherwise update as a .deb.
 */
export function updaterKind(o: { platform: string; appImage: string | undefined }): 'appimage' | 'default' {
  return o.platform === 'linux' && !!o.appImage ? 'appimage' : 'default';
}

/** Everything the update dialogs and the Help menu say. */
export const updateText = {
  available: (name: string, latest: string, current: string) => `${name} ${latest} is available (you have ${current}).`,
  upToDate: (name: string, current: string) => `You have the newest version of ${name} (${current}).`,
  failed: (reason: string) => `Could not check for updates: ${reason}`,
  notPackaged: (name: string) => `Updates only work in the installed ${name}.`,
  ready: (name: string, version: string) => `${name} ${version} is ready to install. The app will close and restart.`,
  downloading: (percent: number) => `Downloading update… ${Math.round(percent)} %`,
  stillSaving: 'Your latest changes are still being saved. Try again in a moment.',
  downloadFailed: (reason: string) => `The update did not download: ${reason}`,
};
