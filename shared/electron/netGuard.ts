// The offline guarantee, as code: which addresses the window may load from or navigate to.
// Pure functions (no Electron), so they are unit-tested in tests/electron-shell.test.ts.

export interface GuardOptions {
  /** Ports on 127.0.0.1 the app itself serves: the local server, and in development the Vite dev server. */
  ports: ReadonlySet<number>;
  /** Development only: let the developer tools load their own pages. */
  devTools?: boolean;
}

const LOOPBACK = '127.0.0.1';

/** May the window make this request? Only the app's own local server (and in-memory data) passes. */
export function isAllowedRequest(url: string, opts: GuardOptions): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  switch (u.protocol) {
    case 'http:':
    case 'ws:':
      return u.hostname === LOOPBACK && opts.ports.has(Number(u.port || 80));
    case 'blob:':
      // blob:http://127.0.0.1:1234/<id> is made by the page itself; check where the page lives.
      return isAllowedRequest(u.pathname, { ...opts, devTools: false });
    case 'data:':
      return true;
    case 'about:':
      return url === 'about:blank' || url === 'about:srcdoc';
    case 'devtools:':
      return !!opts.devTools;
    default:
      // https, wss, ftp and file (a file URL can name a network share) never pass.
      return false;
  }
}

/** May the window navigate here? Only pages of the app's own origin. */
export function isAppNavigation(url: string, appOrigin: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

/** The host a request went to, for the self-test's tally ("127.0.0.1:5174", "data:", "(invalid)"). */
export function requestHost(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'blob:') return `blob:${requestHost(u.pathname)}`;
    return u.host || u.protocol;
  } catch {
    return '(invalid)';
  }
}
