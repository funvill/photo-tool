import type { DesktopApi } from '../desktop/desktopApi';

// The desktop app's extras (a native folder dialog, opening exported files), or undefined in a
// plain browser. Always feature-detect: `desktop?.pickFolder`.
export const desktop: DesktopApi | undefined = (globalThis as { desktop?: DesktopApi }).desktop;
