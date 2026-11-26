// The update controller (shared/electron/updates.ts) driving a fake updater: what it asks, in which
// order it downloads and installs, what the check at start keeps quiet about, and that two checks or
// two downloads never run at once. No Electron, no electron-updater and no network.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readUpdateSettings, updateText, writeUpdateSettings } from '../electron/updateRules';
import { createUpdates, type UpdateDeps, type UpdaterLike } from '../electron/updates';

type CheckResult = Awaited<ReturnType<UpdaterLike['checkForUpdates']>>;

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

/** A deferred promise, for holding a check or a download open. */
function later<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

class FakeUpdater implements UpdaterLike {
  channel: string | null = null;
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowDowngrade = false;
  disableDifferentialDownload = false;
  calls: string[] = [];
  /** What the next checks return (or throw), in order; the last one repeats. */
  checks: (CheckResult | Error | Promise<CheckResult>)[] = [null];
  downloads: (Error | Promise<unknown> | 'ok')[] = ['ok'];
  progress: ((p: { percent: number }) => void)[] = [];

  async checkForUpdates() {
    this.calls.push('check');
    const next = this.checks.length > 1 ? this.checks.shift()! : this.checks[0]!;
    if (next instanceof Error) throw next;
    return next;
  }
  async downloadUpdate() {
    this.calls.push('download');
    const next = this.downloads.length > 1 ? this.downloads.shift()! : this.downloads[0]!;
    if (next instanceof Error) throw next;
    if (next !== 'ok') await next;
    for (const cb of this.progress) cb({ percent: 42 });
    return [];
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean) {
    this.calls.push(`quitAndInstall(${isSilent},${isForceRunAfter})`);
  }
  on(event: string, cb: (p: { percent: number }) => void) {
    if (event === 'download-progress') this.progress.push(cb);
    return this;
  }
}

const available = (version: string): CheckResult => ({ isUpdateAvailable: true, updateInfo: { version } });
const same: CheckResult = { isUpdateAvailable: false, updateInfo: { version: '0.1.33' } };

function setup(o: { answers?: string[]; packaged?: boolean; settings?: { auto: boolean; lastCheck: number | null }; prepareInstall?: () => Promise<boolean>; repo?: UpdateDeps['repo'] } = {}) {
  const updater = new FakeUpdater();
  const settingsFile = join(mkdtempSync(join(tmpdir(), 'updates-')), 'updates.json');
  if (o.settings) writeUpdateSettings(settingsFile, o.settings);
  const asked: { message: string; buttons: string[] }[] = [];
  const answers = [...(o.answers ?? [])];
  const events: string[] = [];
  const progress: (number | null)[] = [];
  const opened: string[] = [];
  let menus = 0;
  const deps: UpdateDeps = {
    updater,
    channel: 'photo-tool',
    productName: 'Photo Tool',
    currentVersion: '0.1.33',
    packaged: o.packaged ?? true,
    repo: o.repo === undefined ? { owner: 'funvill', repo: 'photo-tool' } : o.repo,
    settingsFile,
    ask: async (q) => {
      asked.push(q);
      events.push(`ask:${q.message}`);
      const answer = answers.shift();
      const i = answer === undefined ? q.buttons.length - 1 : q.buttons.indexOf(answer);
      if (i < 0) throw new Error(`no button "${answer}" in ${JSON.stringify(q.buttons)}`);
      return i;
    },
    openExternal: (url) => {
      opened.push(url);
      events.push(`open:${url}`);
    },
    setProgress: (f) => progress.push(f),
    refreshMenu: () => menus++,
    prepareInstall: async () => {
      events.push('prepareInstall');
      return o.prepareInstall ? o.prepareInstall() : true;
    },
    log: () => {},
    now: () => NOW,
  };
  const updates = createUpdates(deps);
  return { updates, updater, settingsFile, asked, events, progress, opened, menus: () => menus, deps };
}

describe('createUpdates', () => {
  it('configures the updater: its own channel, nothing automatic, no downgrade, whole downloads', () => {
    const { updater } = setup();
    expect(updater.channel).toBe('photo-tool');
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.disableDifferentialDownload).toBe(true);
  });

  it('turns downgrades off after setting the channel (electron-updater turns them on with it)', () => {
    const updater = new FakeUpdater();
    let channelSet = false;
    Object.defineProperty(updater, 'channel', {
      get: () => (channelSet ? 'photo-tool' : null),
      set: () => {
        channelSet = true;
        updater.allowDowngrade = true;
      },
    });
    const { deps } = setup();
    createUpdates({ ...deps, updater });
    expect(updater.allowDowngrade).toBe(false);
  });
});

describe('checkNow', () => {
  it('newer → Download → downloads → Restart now → prepareInstall → quitAndInstall', async () => {
    const t = setup({ answers: ['Download', 'Restart now'] });
    t.updater.checks = [available('0.1.40')];
    await t.updates.checkNow();
    expect(t.asked[0]).toEqual({ message: updateText.available('Photo Tool', '0.1.40', '0.1.33'), buttons: ['Download', 'Release notes', 'Later'] });
    expect(t.asked[1]).toEqual({ message: updateText.ready('Photo Tool', '0.1.40'), buttons: ['Restart now', 'Later'] });
    expect(t.updater.calls).toEqual(['check', 'download', 'quitAndInstall(true,true)']);
    expect(t.events.indexOf('prepareInstall')).toBeGreaterThan(1);
    expect(t.progress).toContain(0.42);
    expect(t.progress.indexOf(0.42)).toBeLessThan(t.progress.lastIndexOf(null));
    expect(t.progress.at(-1)).toBeNull();
  });

  it('prepareInstall false → nothing is installed', async () => {
    const t = setup({ answers: ['Download', 'Restart now'], prepareInstall: async () => false });
    t.updater.checks = [available('0.1.40')];
    await t.updates.checkNow();
    expect(t.events).toContain('prepareInstall');
    expect(t.updater.calls).toEqual(['check', 'download']);
  });

  it('Later after the download installs nothing', async () => {
    const t = setup({ answers: ['Download', 'Later'] });
    t.updater.checks = [available('0.1.40')];
    await t.updates.checkNow();
    expect(t.events).not.toContain('prepareInstall');
    expect(t.updater.calls).toEqual(['check', 'download']);
  });

  it('Later on the offer downloads nothing', async () => {
    const t = setup({ answers: ['Later'] });
    t.updater.checks = [available('0.1.40')];
    await t.updates.checkNow();
    expect(t.updater.calls).toEqual(['check']);
  });

  it('same version → says it is the newest', async () => {
    const t = setup();
    t.updater.checks = [same];
    await t.updates.checkNow();
    expect(t.asked).toEqual([{ message: updateText.upToDate('Photo Tool', '0.1.33'), buttons: ['OK'] }]);
  });

  it('a 404 (nothing published yet) → says it is the newest, not an error', async () => {
    const t = setup();
    t.updater.checks = [new Error('HttpError: 404 Not Found')];
    await t.updates.checkNow();
    expect(t.asked).toEqual([{ message: updateText.upToDate('Photo Tool', '0.1.33'), buttons: ['OK'] }]);
  });

  it('another error → says the check failed, with the first line of the reason', async () => {
    const t = setup();
    t.updater.checks = [new Error('net::ERR_INTERNET_DISCONNECTED\n    at stack')];
    await t.updates.checkNow();
    expect(t.asked).toEqual([{ message: updateText.failed('net::ERR_INTERNET_DISCONNECTED'), buttons: ['OK'] }]);
  });

  it('not packaged → says updates need the installed program, and never checks', async () => {
    const t = setup({ packaged: false });
    await t.updates.checkNow();
    expect(t.asked).toEqual([{ message: updateText.notPackaged('Photo Tool'), buttons: ['OK'] }]);
    expect(t.updater.calls).toEqual([]);
  });

  it('Release notes opens the release page, then asks again', async () => {
    const t = setup({ answers: ['Release notes', 'Later'] });
    t.updater.checks = [available('0.1.40')];
    await t.updates.checkNow();
    expect(t.opened).toEqual(['https://github.com/funvill/photo-tool/releases/tag/v0.1.40']);
    expect(t.asked).toHaveLength(2);
    expect(t.asked[1]!.message).toBe(t.asked[0]!.message);
    expect(t.events.indexOf(`open:${t.opened[0]}`)).toBeLessThan(t.events.lastIndexOf(`ask:${t.asked[1]!.message}`));
  });

  it('without a repository there is no Release notes button', async () => {
    const t = setup({ repo: null, answers: ['Later'] });
    t.updater.checks = [available('0.1.40')];
    await t.updates.checkNow();
    expect(t.asked[0]!.buttons).toEqual(['Download', 'Later']);
  });

  it('a failed download says so and can be tried again', async () => {
    const t = setup({ answers: ['Download', 'Try again', 'Later'] });
    t.updater.checks = [available('0.1.40')];
    t.updater.downloads = [new Error('disk full'), 'ok'];
    await t.updates.checkNow();
    expect(t.asked.map((a) => a.message)).toEqual([updateText.available('Photo Tool', '0.1.40', '0.1.33'), updateText.downloadFailed('disk full'), updateText.ready('Photo Tool', '0.1.40')]);
    expect(t.asked[1]!.buttons).toEqual(['Try again', 'Close']);
    expect(t.updater.calls).toEqual(['check', 'download', 'download']);
    expect(t.progress.at(-1)).toBeNull();
  });

  it('a successful manual check counts as the day\'s check', async () => {
    const t = setup({ settings: { auto: true, lastCheck: null } });
    t.updater.checks = [same];
    await t.updates.checkNow();
    expect(readUpdateSettings(t.settingsFile)).toEqual({ auto: true, lastCheck: NOW });
  });
});

describe('the check at start', () => {
  it('is skipped when shouldCheckAtStart says no (no check at all)', async () => {
    for (const t of [
      setup({ packaged: false }),
      setup({ settings: { auto: false, lastCheck: null } }),
      setup({ settings: { auto: true, lastCheck: NOW - DAY + 1 } }),
    ]) {
      await t.updates.checkAtStart({ selfTest: false, disabledByEnv: false });
      expect(t.updater.calls).toEqual([]);
    }
    const t = setup();
    await t.updates.checkAtStart({ selfTest: true, disabledByEnv: false });
    await t.updates.checkAtStart({ selfTest: false, disabledByEnv: true });
    expect(t.updater.calls).toEqual([]);
  });

  it('newer → asks; lastCheck = now', async () => {
    const t = setup({ answers: ['Later'] });
    t.updater.checks = [available('0.1.40')];
    await t.updates.checkAtStart({ selfTest: false, disabledByEnv: false });
    expect(t.asked.map((a) => a.message)).toEqual([updateText.available('Photo Tool', '0.1.40', '0.1.33')]);
    expect(readUpdateSettings(t.settingsFile).lastCheck).toBe(NOW);
  });

  it('up to date → nothing shown; lastCheck = now', async () => {
    const t = setup();
    t.updater.checks = [same];
    await t.updates.checkAtStart({ selfTest: false, disabledByEnv: false });
    expect(t.asked).toEqual([]);
    expect(readUpdateSettings(t.settingsFile)).toEqual({ auto: true, lastCheck: NOW });
  });

  it('nothing published yet (404) → nothing shown; lastCheck = now', async () => {
    const t = setup();
    t.updater.checks = [new Error('HttpError: 404 Not Found')];
    await t.updates.checkAtStart({ selfTest: false, disabledByEnv: false });
    expect(t.asked).toEqual([]);
    expect(readUpdateSettings(t.settingsFile).lastCheck).toBe(NOW);
  });

  it('failure is silent and keeps lastCheck', async () => {
    const t = setup({ settings: { auto: true, lastCheck: NOW - 2 * DAY } });
    t.updater.checks = [new Error('net::ERR_INTERNET_DISCONNECTED')];
    await expect(t.updates.checkAtStart({ selfTest: false, disabledByEnv: false })).resolves.toBeUndefined();
    expect(t.asked).toEqual([]);
    expect(readUpdateSettings(t.settingsFile)).toEqual({ auto: true, lastCheck: NOW - 2 * DAY });
  });

  it('reads a corrupt settings file as the defaults and still checks', async () => {
    const t = setup();
    writeFileSync(t.settingsFile, '{"auto":"yes"');
    t.updater.checks = [same];
    await t.updates.checkAtStart({ selfTest: false, disabledByEnv: false });
    expect(t.updater.calls).toEqual(['check']);
    expect(readUpdateSettings(t.settingsFile)).toEqual({ auto: true, lastCheck: NOW });
  });
});

describe('the Help menu items', () => {
  it('the checkbox shows the setting, toggles settings.auto and rebuilds the menu', () => {
    const t = setup({ settings: { auto: true, lastCheck: 7 } });
    const box = t.updates.menuItems()[1]!;
    expect(box).toMatchObject({ type: 'checkbox', checked: true });
    expect(box.label).toMatch(/^Check for updates &?automatically$/);
    const before = t.menus();
    (box.click as () => void)();
    expect(readUpdateSettings(t.settingsFile)).toEqual({ auto: false, lastCheck: 7 });
    expect(t.menus()).toBeGreaterThan(before);
    expect(t.updates.menuItems()[1]).toMatchObject({ checked: false });
  });

  it('the first item checks now', async () => {
    const t = setup();
    t.updater.checks = [same];
    const item = t.updates.menuItems()[0]!;
    expect(item.label).toMatch(/^Check for &?updates…$/);
    expect(item.enabled).not.toBe(false);
    (item.click as () => void)();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.updater.calls).toEqual(['check']);
  });

  it('while downloading, the item shows the progress and is disabled', async () => {
    const t = setup({ answers: ['Download', 'Later'] });
    t.updater.checks = [available('0.1.40')];
    const hold = later<unknown>();
    t.updater.downloads = [hold.promise];
    const done = t.updates.checkNow();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.updates.menuItems()[0]).toMatchObject({ label: updateText.downloading(0), enabled: false });
    for (const cb of t.updater.progress) cb({ percent: 42 });
    expect(t.updates.menuItems()[0]).toMatchObject({ label: updateText.downloading(42), enabled: false });
    hold.resolve([]);
    await done;
    expect(t.updates.menuItems()[0]).toMatchObject({ enabled: true });
  });
});

describe('one at a time', () => {
  it('concurrent checks share one request', async () => {
    const t = setup();
    const hold = later<CheckResult>();
    t.updater.checks = [hold.promise];
    const a = t.updates.checkNow();
    const b = t.updates.checkNow();
    hold.resolve(same);
    await Promise.all([a, b]);
    expect(t.updater.calls).toEqual(['check']);
    expect(t.asked).toHaveLength(1); // one "newest version" box, not two
  });

  it('the check at start and a manual check share one request and one offer', async () => {
    const t = setup({ answers: ['Later'] });
    const hold = later<CheckResult>();
    t.updater.checks = [hold.promise];
    const a = t.updates.checkAtStart({ selfTest: false, disabledByEnv: false });
    const b = t.updates.checkNow();
    hold.resolve(available('0.1.40'));
    await Promise.all([a, b]);
    expect(t.updater.calls).toEqual(['check']);
    expect(t.asked).toHaveLength(1);
  });

  it('a second Download while one runs starts no second download', async () => {
    const t = setup({ answers: ['Download', 'Later'] });
    t.updater.checks = [available('0.1.40')];
    const hold = later<unknown>();
    t.updater.downloads = [hold.promise];
    const first = t.updates.checkNow();
    await new Promise((r) => setTimeout(r, 0));
    await t.updates.checkNow(); // the menu item is disabled; a call anyway does nothing
    hold.resolve([]);
    await first;
    expect(t.updater.calls).toEqual(['check', 'download']);
  });
});
