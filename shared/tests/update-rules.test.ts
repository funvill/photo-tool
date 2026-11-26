// The pure part of checking for updates (shared/electron/updateRules.ts): the settings file, the
// once-a-day rule, where releases live, which errors mean "no release yet", the words the user reads
// and the hosts the updater may look up. No Electron and no network.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError, newError } from 'builder-util-runtime';
import { describe, expect, it } from 'vitest';
import { hostResolverRules } from '../electron/netGuard';
import { CHECK_INTERVAL_MS, UPDATE_HOSTS, githubRepo, graphicalSudo, installProblem, isNoRelease, pkexecProbe, relaunchOptions, latestReleasePage, readUpdateSettings, releasePage, shouldCheckAtStart, updateText, updaterKind, writeUpdateSettings } from '../electron/updateRules';

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'updates-')), 'updates.json');

describe('update settings', () => {
  it('are the defaults when the file is missing', () => {
    expect(readUpdateSettings(tempFile())).toEqual({ auto: true, lastCheck: null });
  });

  it('are the defaults when the file is not JSON or holds the wrong types', () => {
    for (const text of ['not json', '{"auto":"yes","lastCheck":"x"}', '[]', 'null', '42']) {
      const file = tempFile();
      writeFileSync(file, text);
      expect(readUpdateSettings(file), text).toEqual({ auto: true, lastCheck: null });
    }
  });

  it('keeps each good field even when the other is bad', () => {
    const file = tempFile();
    writeFileSync(file, '{"auto":false,"lastCheck":"x"}');
    expect(readUpdateSettings(file)).toEqual({ auto: false, lastCheck: null });
    writeFileSync(file, '{"auto":"no","lastCheck":1700000000000}');
    expect(readUpdateSettings(file)).toEqual({ auto: true, lastCheck: 1700000000000 });
  });

  it('round-trip through the file, written to a temp file and renamed', () => {
    const file = tempFile();
    writeUpdateSettings(file, { auto: false, lastCheck: 1234 });
    expect(readUpdateSettings(file)).toEqual({ auto: false, lastCheck: 1234 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ auto: false, lastCheck: 1234 });
  });

  it('are written into a folder that does not exist yet', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'updates-')), 'profile', 'updates.json');
    writeUpdateSettings(file, { auto: true, lastCheck: 5 });
    expect(readUpdateSettings(file)).toEqual({ auto: true, lastCheck: 5 });
  });
});

describe('shouldCheckAtStart', () => {
  const now = 1_800_000_000_000;
  const yes = { packaged: true, selfTest: false, disabledByEnv: false, settings: { auto: true, lastCheck: now - CHECK_INTERVAL_MS }, now };

  it('checks once a day, in the installed program, when nothing turns it off', () => {
    expect(CHECK_INTERVAL_MS).toBe(86_400_000);
    expect(shouldCheckAtStart(yes)).toBe(true);
    expect(shouldCheckAtStart({ ...yes, settings: { auto: true, lastCheck: null } })).toBe(true);
  });

  it('does not check when any one thing says no', () => {
    expect(shouldCheckAtStart({ ...yes, packaged: false })).toBe(false);
    expect(shouldCheckAtStart({ ...yes, selfTest: true })).toBe(false);
    expect(shouldCheckAtStart({ ...yes, disabledByEnv: true })).toBe(false);
    expect(shouldCheckAtStart({ ...yes, settings: { ...yes.settings, auto: false } })).toBe(false);
    expect(shouldCheckAtStart({ ...yes, settings: { auto: true, lastCheck: now - 86_399_999 } })).toBe(false);
  });

  it('checks again when the last check is in the future (the clock was changed)', () => {
    expect(shouldCheckAtStart({ ...yes, settings: { auto: true, lastCheck: now + CHECK_INTERVAL_MS * 3 } })).toBe(true);
  });
});

describe('where releases live', () => {
  it('reads owner and repo from product.json\'s repository', () => {
    expect(githubRepo('github:funvill/photo-tool')).toEqual({ owner: 'funvill', repo: 'photo-tool' });
    expect(githubRepo('https://x')).toBeNull();
    expect(githubRepo(undefined)).toBeNull();
    expect(githubRepo('github:funvill')).toBeNull();
    expect(githubRepo('github:a/b/c')).toBeNull();
  });

  it('links the release page of a version', () => {
    expect(releasePage({ owner: 'funvill', repo: 'photo-tool' }, '0.1.40')).toBe('https://github.com/funvill/photo-tool/releases/tag/v0.1.40');
    expect(latestReleasePage({ owner: 'funvill', repo: 'photo-tool' })).toBe('https://github.com/funvill/photo-tool/releases/latest');
  });
});

describe('isNoRelease', () => {
  // The errors as electron-updater 6.8 builds them (providers/GitHubProvider.js): getLatestTagName's
  // error is thrown inside the feed's try, so it reaches the caller rewrapped as INVALID_RELEASE_FEED.
  const http = (status: number) => new HttpError(status, `${status} Not Found\nHeaders: {"content-length":"404"}`);
  const latestNotFound = (cause: Error) =>
    newError(
      `Cannot parse releases feed: ${newError(`Unable to find latest version on GitHub (https://github.com/funvill/photo-tool/releases/latest), please ensure a production release exists: ${cause.stack || cause.message}`, 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND').stack},\nXML:\n<feed/>`,
      'ERR_UPDATER_INVALID_RELEASE_FEED',
    );

  it('is true for "nothing published yet" answers from GitHub', () => {
    expect(isNoRelease(newError('No published versions on GitHub', 'ERR_XML_MISSED_ELEMENT'))).toBe(true); // the feed has no entries
    expect(isNoRelease(newError('No published versions on GitHub', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS'))).toBe(true);
    expect(isNoRelease(latestNotFound(http(404)))).toBe(true); // releases/latest: only drafts or pre-releases
    expect(isNoRelease(http(404))).toBe(true); // the releases feed itself
  });

  it('is false when the release is there but this program\'s update file is not', () => {
    const missing = newError(`Cannot find photo-tool.yml in the latest release artifacts (https://github.com/funvill/photo-tool/releases/download/v0.1.404/photo-tool.yml): ${http(404).stack}`, 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND');
    expect(isNoRelease(missing)).toBe(false);
    expect(isNoRelease(newError('Cannot find channel "photo-tool.yml" update info: HttpError: 404', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'))).toBe(false); // a local feed
  });

  it('is false for other failures, including a 404 that only shows up in a version or a header', () => {
    expect(isNoRelease(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(false);
    expect(isNoRelease(latestNotFound(new Error('net::ERR_INTERNET_DISCONNECTED')))).toBe(false);
    expect(isNoRelease(http(403))).toBe(false);
    expect(isNoRelease(new Error('Cannot download https://github.com/funvill/photo-tool/releases/download/v0.1.404/x.exe'))).toBe(false);
    expect(isNoRelease('HttpError: 404')).toBe(false);
    expect(isNoRelease(null)).toBe(false);
    expect(isNoRelease(undefined)).toBe(false);
  });
});

describe('before installing: what can be checked before anything is closed', () => {
  const linuxDeb = { platform: 'linux', kind: 'default' as const, files: ['/home/me/.cache/photo-tool-updater/pending/photo-tool_0.1.40_amd64.deb'], appImage: undefined, sudo: 'pkexec', exists: () => true, writable: () => true };

  it('graphicalSudo: the first of gksudo, kdesudo, pkexec, beesu on PATH (electron-updater\'s order), or null', () => {
    const on = (...paths: string[]) => (p: string) => paths.includes(p.replace(/\\/g, '/'));
    expect(graphicalSudo(['/usr/bin', '/bin'], on('/usr/bin/pkexec', '/bin/beesu'))).toBe('pkexec');
    expect(graphicalSudo(['/usr/bin'], on('/usr/bin/pkexec', '/usr/bin/kdesudo'))).toBe('kdesudo');
    expect(graphicalSudo(['/usr/bin'], on('/usr/bin/sudo'))).toBeNull();
    expect(graphicalSudo([], () => true)).toBeNull();
  });

  it('installProblem: nothing in the way', () => {
    expect(installProblem(linuxDeb)).toBeNull();
    expect(installProblem({ ...linuxDeb, platform: 'win32', files: ['C:\\cache\\Photo-Tool-Setup-0.1.40.exe'], sudo: null })).toBeNull();
    expect(installProblem({ ...linuxDeb, kind: 'appimage', appImage: '/home/me/Apps/Photo-Tool-0.1.33.AppImage', sudo: null })).toBeNull();
  });

  it('installProblem: the downloaded file is gone', () => {
    expect(installProblem({ ...linuxDeb, exists: () => false })).toBe(updateText.problem.missingFile);
    expect(installProblem({ ...linuxDeb, files: [] })).toBe(updateText.problem.missingFile);
  });

  it("installProblem: the AppImage's folder cannot be written (electron-updater deletes the old file first)", () => {
    const appImage = '/opt/Apps/Photo-Tool-0.1.33.AppImage';
    const writable = (p: string) => p !== '/opt/Apps';
    expect(installProblem({ ...linuxDeb, kind: 'appimage', appImage, writable, sudo: null })).toBe(updateText.problem.appImageNotWritable('/opt/Apps'));
    expect(installProblem({ ...linuxDeb, kind: 'appimage', appImage, exists: (p) => p !== appImage, sudo: null })).toBe(updateText.problem.appImageNotWritable('/opt/Apps'));
  });

  it('installProblem: a .deb with no graphical way to ask for the password', () => {
    expect(installProblem({ ...linuxDeb, sudo: null })).toBe(updateText.problem.noSudo);
  });

  it('pkexecProbe: 0 can install; 126 the user closed the password box; anything else cannot ask (no polkit agent, refused)', () => {
    expect(pkexecProbe(0)).toBe('ok');
    expect(pkexecProbe(126)).toBe('dismissed');
    expect(pkexecProbe(127)).toBe('unusable');
    expect(pkexecProbe(1)).toBe('unusable');
    expect(pkexecProbe(null)).toBe('unusable');
  });

  it('relaunchOptions: an AppImage starts again from its own file, not the mount it ran from', () => {
    expect(relaunchOptions({ kind: 'appimage', appImage: '/home/me/Apps/Photo-Tool-0.1.33.AppImage' })).toEqual({ execPath: '/home/me/Apps/Photo-Tool-0.1.33.AppImage' });
    expect(relaunchOptions({ kind: 'default', appImage: undefined })).toBeUndefined();
  });
});

describe('updaterKind', () => {
  // Both Linux packages are built from one folder, so the AppImage may carry resources/package-type
  // = deb, and electron-updater would then update it as a .deb. The AppImage's own APPIMAGE decides.
  it('is the AppImage updater on Linux whenever APPIMAGE is set, whatever package-type says', () => {
    expect(updaterKind({ platform: 'linux', appImage: '/home/me/Apps/Photo-Tool-0.1.40.AppImage' })).toBe('appimage');
  });

  it("is electron-updater's own choice otherwise", () => {
    expect(updaterKind({ platform: 'linux', appImage: undefined })).toBe('default');
    expect(updaterKind({ platform: 'linux', appImage: '' })).toBe('default');
    expect(updaterKind({ platform: 'win32', appImage: 'C:\\x.AppImage' })).toBe('default');
    expect(updaterKind({ platform: 'darwin', appImage: undefined })).toBe('default');
  });
});

describe('updateText', () => {
  it('says each thing in plain words', () => {
    expect(updateText.available('Photo Tool', '0.1.40', '0.1.33')).toBe('Photo Tool 0.1.40 is available (you have 0.1.33).');
    expect(updateText.upToDate('Photo Tool', '0.1.33')).toBe('You have the newest version of Photo Tool (0.1.33).');
    expect(updateText.failed('offline')).toBe('Could not check for updates: offline');
    expect(updateText.notPackaged('Photo Tool')).toBe('Updates only work in the installed Photo Tool.');
    expect(updateText.ready('Photo Tool', '0.1.40')).toBe('Photo Tool 0.1.40 is ready to install. The app will close and restart.');
    expect(updateText.downloading(41.6)).toBe('Downloading update… 42 %');
    expect(updateText.stillSaving).toBe('Your latest changes are still being saved. Try again in a moment.');
    expect(updateText.downloadFailed('disk full')).toBe('The update did not download: disk full');
  });
});

describe('the update hosts', () => {
  it('are exactly GitHub\'s four, in order', () => {
    expect(UPDATE_HOSTS).toEqual(['github.com', 'api.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
  });

  it('are the only names looked up besides the loopback ones', () => {
    expect(hostResolverRules(UPDATE_HOSTS)).toBe(
      'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE github.com, EXCLUDE api.github.com, EXCLUDE objects.githubusercontent.com, EXCLUDE release-assets.githubusercontent.com',
    );
  });
});
