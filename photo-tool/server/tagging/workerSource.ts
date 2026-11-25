// The tagging worker's source file, for running from source (the development server, tests). The desktop app
// runs its built copy (tagging-worker.cjs, see electron/gallery-server-host.ts); this file is never in its bundle.
import { fileURLToPath } from 'node:url';

export const taggingWorkerSource = (): string => fileURLToPath(new URL('./worker.ts', import.meta.url));
