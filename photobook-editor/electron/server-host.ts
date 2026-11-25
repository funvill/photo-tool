// The editor's local server (photobook-editor/server/app.ts, the same one `npm start` runs) inside an
// Electron utility process: see shared/electron/serverHost.ts. Photo Tool's is
// photo-tool/electron/server-host.ts.
import { join } from 'node:path';
import { resourceCheck, runServerHost } from '../../shared/electron/serverHost';

export type { HostMessage, HostReply, StartMessage } from '../../shared/electron/serverHost';

runServerHost(async (msg, post) => {
  // Loaded here, not at the top: see runServerHost.
  const { createApp } = await import('../server/app');
  const restart = () => post({ type: 'restart' });
  const { app, store } = createApp(msg.dataDir, {
    // The folder shared with Photo Tool (shared/electron/config.ts photoInfoFallbackDir), from the shell.
    photoInfoFallbackDir: msg.photoInfoFallbackDir,
    ...(msg.resourceRoot ? { resourceRoot: msg.resourceRoot, staticDir: join(msg.resourceRoot, 'web'), restart } : { devWebUrl: msg.devWebUrl }),
  });
  return { app, close: () => store.close() };
}, resourceCheck(['web/index.html']));
