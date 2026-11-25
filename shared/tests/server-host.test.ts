// The server host's listen step (shared/electron/serverHost.ts): the desktop shell asks for the port the
// server had last time, so the page keeps its origin (and its localStorage) across restarts. When that
// port is taken or refused, the host falls back to any free port. Real servers on 127.0.0.1 only.
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { listenWithFallback } from '../electron/serverHost';

const open: Server[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise<void>((done) => (s.listening ? s.close(() => done()) : done()))));
});

const portOf = (s: Server) => (s.address() as AddressInfo).port;

/** A port nothing listens on right now (the system's pick, released again). */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((done) => s.listen(0, '127.0.0.1', done));
  const port = portOf(s);
  await new Promise<void>((done) => s.close(() => done()));
  return port;
}

/** Another program holding `port` on 127.0.0.1. */
async function hold(port: number): Promise<Server> {
  const s = createServer();
  open.push(s);
  await new Promise<void>((done) => s.listen(port, '127.0.0.1', done));
  return s;
}

describe('listenWithFallback', () => {
  it('listens on exactly the port asked for when it is free', async () => {
    const port = await freePort();
    const s = await listenWithFallback(express(), port, true);
    open.push(s);
    expect(portOf(s)).toBe(port);
    expect((s.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('takes any free port when the one asked for is busy and fallback is on', async () => {
    const holder = await hold(0);
    const busy = portOf(holder);
    const s = await listenWithFallback(express(), busy, true);
    open.push(s);
    expect(s.listening).toBe(true);
    expect(portOf(s)).not.toBe(busy);
    expect((s.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('fails with EADDRINUSE when the port is busy and fallback is off', async () => {
    const holder = await hold(0);
    await expect(listenWithFallback(express(), portOf(holder), false)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  /** An app whose first listen is refused with `code`; later calls go to a real express app. */
  function refusingApp(code: string) {
    const real = express();
    const calls: { port: number; host: string }[] = [];
    const app = {
      listen: ((port: number, host: string, cb?: (err?: Error) => void) => {
        calls.push({ port, host });
        if (calls.length > 1) {
          const s = real.listen(port, host, cb);
          open.push(s);
          return s;
        }
        const fake = new EventEmitter() as unknown as Server;
        const err = Object.assign(new Error(`listen ${code}: 127.0.0.1:${port}`), { code });
        setImmediate(() => {
          cb?.(err);
          fake.emit('error', err);
        });
        return fake;
      }) as unknown as express.Express['listen'],
    };
    return { app, calls };
  }

  it('falls back the same way when the port is refused (EACCES, e.g. reserved by Windows)', async () => {
    const { app, calls } = refusingApp('EACCES');
    const s = await listenWithFallback(app, 50123, true);
    expect(s.listening).toBe(true);
    expect(calls).toEqual([
      { port: 50123, host: '127.0.0.1' },
      { port: 0, host: '127.0.0.1' },
    ]);
  });

  it('fails with EACCES when fallback is off', async () => {
    const { app, calls } = refusingApp('EACCES');
    await expect(listenWithFallback(app, 50123, false)).rejects.toMatchObject({ code: 'EACCES' });
    expect(calls).toHaveLength(1);
  });

  it('does not fall back on any other error', async () => {
    const { app, calls } = refusingApp('EINVAL');
    await expect(listenWithFallback(app, 50123, true)).rejects.toMatchObject({ code: 'EINVAL' });
    expect(calls).toHaveLength(1);
  });

  it('does not retry when port 0 itself was asked for', async () => {
    const { app, calls } = refusingApp('EACCES');
    await expect(listenWithFallback(app, 0, true)).rejects.toMatchObject({ code: 'EACCES' });
    expect(calls).toHaveLength(1);
  });
});
