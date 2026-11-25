/// <reference types="vite/client" />

/** True in the web (GitHub Pages) build, where the backend runs in the browser. Set in vite.config.ts. */
declare const __BROWSER_BACKEND__: boolean;
/** package.json's version, e.g. "0.1.1". Set in vite.config.ts. */
declare const __APP_VERSION__: string;
