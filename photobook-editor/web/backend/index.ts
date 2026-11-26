import { httpBackend } from './http';
import type { Backend } from './types';

// The editor's backend: the local server, over HTTP. (The editor is a desktop program; there is no
// in-browser backend any more.)
export const backend: Backend = httpBackend;
