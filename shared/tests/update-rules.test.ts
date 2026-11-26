// The pure part of checking for updates (shared/electron/updateRules.ts): the settings file, the
// once-a-day rule, where releases live, which errors mean "no release yet", the words the user reads
// and the hosts the updater may look up. No Electron and no network.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostResolverRules } from '../electron/netGuard';
import { CHECK_INTERVAL_MS, UPDATE_HOSTS, githubRepo, isNoRelease, latestReleasePage, readUpdateSettings, releasePage, shouldCheckAtStart, updateText, writeUpdateSettings } from '../electron/updateRules';

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
  it('is true for "nothing published yet" answers from GitHub', () => {
    expect(isNoRelease(new Error('HttpError: 404 Not Found'))).toBe(true);
    expect(isNoRelease(new Error('Unable to find latest version on GitHub (https://github.com/funvill/photo-tool/releases/latest), please ensure a production release exists'))).toBe(true);
    expect(isNoRelease(new Error('No published versions on GitHub'))).toBe(true);
    expect(isNoRelease('HttpError: 404')).toBe(true);
  });

  it('is false for other failures', () => {
    expect(isNoRelease(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(false);
    expect(isNoRelease(new Error('HttpError: 403 rate limit exceeded'))).toBe(false);
    expect(isNoRelease(null)).toBe(false);
    expect(isNoRelease(undefined)).toBe(false);
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
