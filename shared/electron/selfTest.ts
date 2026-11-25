// What both programs' built-in acceptance tests share (each program's own steps live with it). A test
// runs only with explicit flags:
//
//   <program> --self-test <photo folder> --self-test-out <folder>
//
// runDesktopApp.ts adds what it saw (console messages, failed loads, requests the offline filter
// cancelled, whether the server stopped cleanly) and writes <folder>/result.json, failing either
// test on the same rules.
import type { BrowserWindow, Session } from 'electron';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Step {
  ok: boolean;
  ms?: number;
  error?: string;
  [key: string]: unknown;
}

export interface SelfTestContext {
  /** The local server, e.g. http://127.0.0.1:51234 */
  base: string;
  photos: string;
  out: string;
  win: BrowserWindow;
  session: Session;
  log: (...a: unknown[]) => void;
}

export const sleep = (ms: number) => new Promise((d) => setTimeout(d, ms));

/** What both tests use: named steps, code run in the page, waiting on the page, and screenshots. */
export function harness(ctx: SelfTestContext) {
  const steps: Record<string, Step> = {};
  const { win, log } = ctx;
  const js = <T = any>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true);

  async function step(name: string, fn: () => Promise<Omit<Step, 'ok'> & { ok?: boolean }>) {
    const t = Date.now();
    try {
      const r = await fn();
      steps[name] = { ...r, ok: r.ok !== false, ms: Date.now() - t };
    } catch (e) {
      steps[name] = { ok: false, ms: Date.now() - t, error: String((e as Error)?.stack ?? e) };
    }
    log('self-test', name, steps[name]);
    return steps[name].ok;
  }

  async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(ctx.base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const json = (await res.json()) as T;
    if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${JSON.stringify(json)}`);
    return json;
  }

  async function waitFor<T>(code: string, good: (v: T) => boolean, timeoutMs: number): Promise<T> {
    const end = Date.now() + timeoutMs;
    let v = await js<T>(code);
    while (!good(v) && Date.now() < end) {
      await sleep(500);
      v = await js<T>(code);
    }
    return v;
  }

  async function screenshot(name: string) {
    let img = await win.webContents.capturePage();
    if (img.isEmpty()) {
      win.showInactive();
      await sleep(1000);
      img = await win.webContents.capturePage();
    }
    const file = join(ctx.out, name);
    writeFileSync(file, img.toPNG());
    return { screenshot: file, screenshotBytes: statSync(file).size, screenshotSize: img.getSize() };
  }

  return { steps, step, js, api, waitFor, screenshot };
}

export type Harness = ReturnType<typeof harness>;

/**
 * Proof that the offline filter is switched on, without touching the network: a request to a port
 * on this computer that is not the app's must be cancelled before it is sent, and the window must
 * not navigate there.
 */
export async function offlineChecks({ step, js }: Harness, ctx: SelfTestContext) {
  await step('filterControl', async () => {
    const url = SELF_TEST_CONTROL_URLS[0]!;
    try {
      await ctx.session.fetch(url);
      return { ok: false, url, outcome: 'the request was sent' };
    } catch (e) {
      const outcome = String((e as Error)?.message ?? e);
      return { ok: /ERR_BLOCKED_BY_CLIENT/.test(outcome), url, outcome };
    }
  });

  await step('navigationBlocked', async () => {
    const before = ctx.win.webContents.getURL();
    await js(`void (location.href = ${JSON.stringify(SELF_TEST_CONTROL_URLS[1])})`);
    await sleep(800);
    const after = ctx.win.webContents.getURL();
    return { ok: after === before, before, after };
  });
}

/** The two requests offlineChecks makes on purpose: the test's own proof that blocking works. */
export const SELF_TEST_CONTROL_URLS = ['http://127.0.0.1:9/self-test-control', 'http://127.0.0.1:9/self-test-navigation'];
