// Checking GitHub for a new version: the controller. It drives an updater passed in (electron-updater's
// autoUpdater in the shell, a fake in shared/tests/updates.test.ts) and asks the user through `ask`, so
// nothing here imports Electron or electron-updater at run time.
//
//   check at start   quiet: once a day, packaged only (updateRules.shouldCheckAtStart); a failure is logged, never shown
//   Help menu        "Check for updates…" (always shows a result) and "Check for updates automatically"
//   update found     Download / Release notes / Later
//   downloading      the taskbar progress bar, and the menu item reads "Downloading update… 42 %"
//   downloaded       Restart now / Later; Restart now runs the shell's prepareInstall, then installs. Until
//                    installed (Later, or the install called off) the menu item reads "Install update 1.2.3…"
//
// One check and one download at a time: a second request shares the one in flight.
import type { OutgoingHttpHeaders } from 'node:http';
import type { MenuItemConstructorOptions } from 'electron';
import { isNoRelease, readUpdateSettings, releasePage, shouldCheckAtStart, updateText, writeUpdateSettings, type UpdateSettings } from './updateRules';

/** The part of electron-updater's AppUpdater the controller uses. */
export interface UpdaterLike {
  channel: string | null;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  disableDifferentialDownload: boolean;
  /** Added to every request, last (so these win over electron-updater's own). */
  requestHeaders: OutgoingHttpHeaders | null;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string } } | null>;
  /** Resolves to the downloaded files (the installer). */
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'download-progress', cb: (p: { percent: number }) => void): unknown;
  on(event: 'error', cb: (e: Error) => void): unknown;
  removeListener(event: 'error', cb: (e: Error) => void): unknown;
}

export interface UpdateDeps {
  updater: UpdaterLike;
  /** The program's own update channel ('photo-tool', 'photobook-editor'): its update file is <channel>.yml. */
  channel: string;
  productName: string;
  currentVersion: string;
  packaged: boolean;
  /** Where the releases are, for Release notes; null leaves that button out. */
  repo: { owner: string; repo: string } | null;
  /** <profileDir>/updates.json */
  settingsFile: string;
  /** Show a message with these buttons; resolves to the index of the one pressed. */
  ask(o: { message: string; buttons: string[] }): Promise<number>;
  openExternal(url: string): void;
  /** The window's taskbar progress, 0 to 1; null takes it away. */
  setProgress(fraction: number | null): void;
  /** Build the Help menu again (the items below changed). */
  refreshMenu(): void;
  /** The shell's safe way out before installing, given the downloaded files; false calls the install off. */
  prepareInstall(o: { files: string[] }): Promise<boolean>;
  /** The install failed after prepareInstall closed the app's window and server: the shell recovers. */
  installFailed(reason: string): void;
  log(...a: unknown[]): void;
  now(): number;
}

export interface Updates {
  checkAtStart(o: { selfTest: boolean; disabledByEnv: boolean }): Promise<void>;
  checkNow(): Promise<void>;
  /** "Check for updates…" (or the download's progress, disabled) and the "Check for updates automatically" checkbox. */
  menuItems(): MenuItemConstructorOptions[];
}

type Outcome = { kind: 'available'; version: string } | { kind: 'upToDate' } | { kind: 'failed'; error: unknown };

const BUTTONS = {
  download: 'Download',
  notes: 'Release notes',
  later: 'Later',
  restart: 'Restart now',
  again: 'Try again',
  close: 'Close',
  ok: 'OK',
};

/** The first line of an error, short enough for a message box. */
function reason(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? text;
  return line.trim().slice(0, 300);
}

/** Sent in place of electron-updater's per-install id: the same for everyone, so it says nothing about the user. */
export const NO_STAGING_ID = '00000000-0000-0000-0000-000000000000';

/**
 * electron-updater makes a random id per install (<userData>/.updaterId), for staged rollouts, and
 * sends it as x-user-staging-id with every check. Releases here are never staged, so: every user is in
 * every rollout, the id is never made, and the header (which cannot be left out, only overridden: the
 * request headers are applied last) carries the same zeros for everyone. stagingUserIdPromise is
 * electron-updater's own (not typed); shared/tests/updates.test.ts checks this against its real class.
 */
function withoutStagingId(updater: UpdaterLike) {
  updater.requestHeaders = { ...updater.requestHeaders, 'x-user-staging-id': NO_STAGING_ID };
  const u = updater as unknown as { isUserWithinRollout?: unknown; stagingUserIdPromise?: unknown };
  if ('isUserWithinRollout' in u) u.isUserWithinRollout = () => true;
  if ('stagingUserIdPromise' in u) u.stagingUserIdPromise = { value: Promise.resolve(NO_STAGING_ID) };
}

export function createUpdates(d: UpdateDeps): Updates {
  const { updater } = d;
  // electron-updater turns allowDowngrade on whenever a channel is set; an older release is never offered.
  updater.channel = d.channel;
  updater.allowDowngrade = false;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  // Every update downloads the whole installer (no block maps are published).
  updater.disableDifferentialDownload = true;
  withoutStagingId(updater);

  let checking: Promise<Outcome> | null = null;
  let offering: Promise<void> | null = null;
  let downloading: Promise<void> | null = null;
  /** The Restart now / Later question while it is open. */
  let installOffer: Promise<void> | null = null;
  /** The version downloaded and not yet installed (Later, or the install called off): offered again from the menu. */
  let ready: string | null = null;
  /** What the download of `ready` resolved to. */
  let files: string[] = [];
  /** The download's progress in percent, or null when nothing is downloading. */
  let percent: number | null = null;

  updater.on('download-progress', (p) => {
    const before = percent === null ? null : Math.round(percent);
    percent = p.percent;
    d.setProgress(p.percent / 100);
    if (Math.round(p.percent) !== before) d.refreshMenu();
  });

  const settings = (): UpdateSettings => readUpdateSettings(d.settingsFile);
  function save(s: UpdateSettings) {
    try {
      writeUpdateSettings(d.settingsFile, s);
    } catch (e) {
      d.log('could not save the update settings', String(e));
    }
  }
  const ask = async (message: string, buttons: string[]) => buttons[await d.ask({ message, buttons })];

  /** One check at a time: a second caller gets the answer of the one in flight. */
  function check(): Promise<Outcome> {
    checking ??= (async (): Promise<Outcome> => {
      try {
        const r = await updater.checkForUpdates();
        const outcome: Outcome = r?.isUpdateAvailable ? { kind: 'available', version: r.updateInfo.version } : { kind: 'upToDate' };
        save({ ...settings(), lastCheck: d.now() });
        return outcome;
      } catch (e) {
        if (!isNoRelease(e)) return { kind: 'failed', error: e };
        // Nothing published yet: an answer all the same.
        save({ ...settings(), lastCheck: d.now() });
        return { kind: 'upToDate' };
      }
    })().finally(() => {
      checking = null;
    });
    return checking;
  }

  function setPercent(p: number | null) {
    percent = p;
    d.setProgress(p === null ? null : p / 100);
    d.refreshMenu();
  }

  /** Downloaded: Restart now / Later. Anything but an install leaves it ready, for the menu to offer again. */
  function offerInstall(version: string): Promise<void> {
    installOffer ??= (async () => {
      if ((await ask(updateText.ready(d.productName, version), [BUTTONS.restart, BUTTONS.later])) !== BUTTONS.restart) return;
      if (!(await d.prepareInstall({ files }))) {
        d.log('update install called off');
        return;
      }
      d.log('installing update', version);
      install();
    })().finally(() => {
      installOffer = null;
      d.refreshMenu();
    });
    return installOffer;
  }

  /**
   * Silently, then start the new version (the NSIS installer is one-click; Linux ignores the first flag).
   * electron-updater installs synchronously and queues app.quit only when that worked; a failure is an
   * `error` event (or a throw), and it sets quitAndInstallCalled back to false. Either way: installFailed.
   */
  function install() {
    let failure: unknown = null;
    const onError = (e: Error) => {
      failure ??= e;
    };
    updater.on('error', onError);
    try {
      updater.quitAndInstall(true, true);
    } catch (e) {
      failure ??= e;
    } finally {
      updater.removeListener('error', onError);
    }
    if (failure === null && (updater as { quitAndInstallCalled?: unknown }).quitAndInstallCalled !== false) return;
    const why = failure === null ? 'the installer did not start.' : reason(failure);
    d.log('update install failed', why);
    d.installFailed(why);
  }

  function download(version: string): Promise<void> {
    downloading ??= (async () => {
      for (;;) {
        setPercent(0);
        try {
          files = await updater.downloadUpdate();
        } catch (e) {
          setPercent(null);
          d.log('update download failed', reason(e));
          if ((await ask(updateText.downloadFailed(reason(e)), [BUTTONS.again, BUTTONS.close])) === BUTTONS.again) continue;
          return;
        }
        ready = version;
        setPercent(null);
        d.log('update downloaded', version);
        break;
      }
      await offerInstall(version);
    })().finally(() => {
      downloading = null;
      d.refreshMenu();
    });
    return downloading;
  }

  /** Update found: one offer at a time. */
  function offer(version: string): Promise<void> {
    offering ??= (async () => {
      const buttons = d.repo ? [BUTTONS.download, BUTTONS.notes, BUTTONS.later] : [BUTTONS.download, BUTTONS.later];
      for (;;) {
        const choice = await ask(updateText.available(d.productName, version, d.currentVersion), buttons);
        if (choice === BUTTONS.notes && d.repo) {
          d.openExternal(releasePage(d.repo, version));
          continue;
        }
        if (choice === BUTTONS.download) void download(version);
        return;
      }
    })().finally(() => {
      offering = null;
    });
    return offering.then(() => downloading ?? undefined);
  }

  /** The manual check in progress (its dialogs included): a second click joins it. */
  let manual: Promise<void> | null = null;
  function checkNow(): Promise<void> {
    if (downloading || offering || installOffer) return Promise.resolve();
    if (ready) return offerInstall(ready);
    manual ??= (async () => {
      if (!d.packaged) {
        await ask(updateText.notPackaged(d.productName), [BUTTONS.ok]);
        return;
      }
      const o = await check();
      d.log('update check', o.kind === 'failed' ? { kind: 'failed', reason: reason(o.error) } : o);
      if (o.kind === 'available') return offer(o.version);
      if (offering || downloading) return; // the check at start found it first and is offering it
      if (o.kind === 'upToDate') await ask(updateText.upToDate(d.productName, d.currentVersion), [BUTTONS.ok]);
      else await ask(updateText.failed(reason(o.error)), [BUTTONS.ok]);
    })().finally(() => {
      manual = null;
    });
    return manual;
  }

  async function checkAtStart(o: { selfTest: boolean; disabledByEnv: boolean }) {
    try {
      if (!shouldCheckAtStart({ packaged: d.packaged, selfTest: o.selfTest, disabledByEnv: o.disabledByEnv, settings: settings(), now: d.now() })) {
        d.log('update check at start skipped');
        return;
      }
      const r = await check();
      if (r.kind === 'failed') {
        d.log('update check at start failed', reason(r.error));
        return;
      }
      d.log('update check at start', r);
      // Already downloaded: the Help menu offers to install it.
      if (r.kind === 'available' && r.version !== ready) await offer(r.version);
    } catch (e) {
      d.log('update check at start failed', String(e));
    }
  }

  function menuItems(): MenuItemConstructorOptions[] {
    const auto = settings().auto;
    return [
      percent !== null
        ? { label: updateText.downloading(percent), enabled: false }
        : { label: ready ? updateText.installMenu(ready) : 'Check for &updates…', enabled: true, click: () => void checkNow() },
      {
        label: 'Check for updates &automatically',
        type: 'checkbox',
        checked: auto,
        click: () => {
          save({ ...settings(), auto: !auto });
          d.refreshMenu();
        },
      },
    ];
  }

  return { checkAtStart, checkNow, menuItems };
}
