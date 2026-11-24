// How long the gallery takes to work its shown list out again after one photo is hidden (what H does),
// on a folder of 5,000 analysed photos with stacks on. Run: npx tsx scripts/bench-gallery-facts.ts
// Not part of the test suite: the first build alone takes seconds.
import type { GalleryItem } from '../src/gallery/server/app';
import { selectVisible } from '../src/gallery/web/store';

const N = Number(process.argv[2] ?? 5000);
const ROUNDS = 5;

let seed = 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const hex = (bits: number) => Array.from({ length: bits / 4 }, () => Math.floor(rand() * 16).toString(16)).join('');

function item(i: number, dHash: string): GalleryItem {
  const at = new Date(Date.UTC(2026, 0, 1) + i * 20_000).toISOString().slice(0, 19);
  return {
    path: `D:\\Trip\\p${i}.jpg`, folder: 'D:\\Trip', fileName: `p${i}.jpg`, relDir: '', size: 1000 + i, mtimeMs: 1, width: 4000, height: 3000,
    format: 'jpeg', capturedAt: at, gpsLat: null, gpsLon: null, camera: null, exif: null, key: `k${i}`,
    analysis: { sharpness: 50 + rand() * 100, meanLuma: 0.3 + rand() * 0.4, clippedShadows: 0, clippedHighlights: 0, dHash, saliencyX: 0.5, saliencyY: 0.5 },
    info: {}, infoSource: 'folder', effectiveDate: at, effectiveLat: null, effectiveLon: null,
  };
}

// Bursts of three near-identical shots, every fourth photo on its own.
let items: GalleryItem[] = [];
let burst = hex(64);
for (let i = 0; i < N; i++) {
  if (i % 4 === 0) burst = hex(64);
  items.push(item(i, i % 4 === 3 ? hex(64) : burst));
}

const state = (list: GalleryItem[]) => ({ items: list, sort: 'date' as const, filter: {}, stacked: true, openStacks: [] as string[], progress: null });

let t = performance.now();
const shown = selectVisible(state(items)).length;
console.log(`${N} photos, ${shown} tiles; first build ${(performance.now() - t).toFixed(0)} ms`);

const times: number[] = [];
for (let r = 0; r < ROUNDS; r++) {
  // What a saved H does to the list: one photo replaced by the server's reply, the rest kept.
  const at = 10 + r * 97;
  items = items.map((x, i) => (i === at ? { ...x, info: { ...x.info, hidden: true }, analysis: x.analysis && { ...x.analysis } } : x));
  t = performance.now();
  selectVisible(state(items));
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
console.log(`after one hide: median ${times[Math.floor(ROUNDS / 2)].toFixed(1)} ms (min ${times[0].toFixed(1)}, max ${times.at(-1)!.toFixed(1)})`);
