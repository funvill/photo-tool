// The gallery's Map tab: which requests may go to OpenStreetMap (the one network exception, gallery
// window only, after the user said yes), the remembered answer, and which photos get a marker.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { galleryRequestAllowed, isMapTileRequest, mapHostResolverRules, mapTileRequestHeaders, mapTileUserAgent, OSM_TILE_ORIGIN, readMapConsent, writeMapConsent } from '../electron/mapTiles';
import { locatedItems, noLocationText, OSM_TILE_URL } from '../core/galleryMap';
import { hostResolverRules } from '../../shared/electron/netGuard';
import { UPDATE_HOSTS } from '../../shared/electron/updateRules';

describe('map tile requests', () => {
  it('names the OpenStreetMap tile server', () => {
    expect(OSM_TILE_ORIGIN).toBe('https://tile.openstreetmap.org');
    expect(OSM_TILE_URL).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  });

  it('accepts a GET of one tile', () => {
    expect(isMapTileRequest('https://tile.openstreetmap.org/3/4/2.png', 'GET')).toBe(true);
    expect(isMapTileRequest('https://tile.openstreetmap.org/19/262143/174762.png', 'GET')).toBe(true);
    // The default port written out is still the default port.
    expect(isMapTileRequest('https://tile.openstreetmap.org:443/3/4/2.png', 'GET')).toBe(true);
  });

  it('refuses anything else', () => {
    expect(isMapTileRequest('https://tile.openstreetmap.org/3/4/2.png', 'POST')).toBe(false);
    expect(isMapTileRequest('https://tile.openstreetmap.org/3/4/2.png', 'HEAD')).toBe(false);
    expect(isMapTileRequest('https://tile.openstreetmap.org/3/4/2.png', 'get')).toBe(false);
    for (const url of [
      'http://tile.openstreetmap.org/3/4/2.png',
      'https://a.tile.openstreetmap.org/3/4/2.png',
      'https://example.com/3/4/2.png',
      'https://tile.openstreetmap.org.evil.com/1/1/1.png',
      'https://tile.openstreetmap.org./1/1/1.png',
      'https://tile.openstreetmap.org/3/4/2.png?x=1',
      'https://tile.openstreetmap.org/3/4/2.png?',
      'https://tile.openstreetmap.org/3/4/2.png#a',
      'https://tile.openstreetmap.org/3/4/2.jpg',
      'https://tile.openstreetmap.org/3/4/2',
      'https://tile.openstreetmap.org/3/4/2.png/x',
      'https://tile.openstreetmap.org/a/4/2.png',
      'https://tile.openstreetmap.org/-1/4/2.png',
      'https://tile.openstreetmap.org/3/4/%32.png',
      'https://tile.openstreetmap.org/',
      'https://user@tile.openstreetmap.org/3/4/2.png',
      'https://user:pw@tile.openstreetmap.org/3/4/2.png',
      'https://tile.openstreetmap.org:8443/3/4/2.png',
      'wss://tile.openstreetmap.org/3/4/2.png',
      'nonsense',
    ]) {
      expect(isMapTileRequest(url, 'GET'), url).toBe(false);
    }
  });
});

describe("the gallery window's request guard", () => {
  const ports = new Set([51234]);
  const tile = 'https://tile.openstreetmap.org/3/4/2.png';

  it('with maps off cancels tiles, like everything not local', () => {
    const opts = { ports, mapsAllowed: false };
    expect(galleryRequestAllowed(tile, 'GET', opts)).toBe(false);
    expect(galleryRequestAllowed('http://127.0.0.1:51234/api/gallery/items', 'GET', opts)).toBe(true);
  });

  it('with maps on lets exactly the tiles through', () => {
    const opts = { ports, mapsAllowed: true };
    expect(galleryRequestAllowed(tile, 'GET', opts)).toBe(true);
    expect(galleryRequestAllowed(tile, 'POST', opts)).toBe(false);
    expect(galleryRequestAllowed('https://example.com/', 'GET', opts)).toBe(false);
    expect(galleryRequestAllowed('https://tile.openstreetmap.org/3/4/2.png?q=1', 'GET', opts)).toBe(false);
    expect(galleryRequestAllowed('http://127.0.0.1:9/', 'GET', opts)).toBe(false);
    expect(galleryRequestAllowed('http://127.0.0.1:51234/', 'GET', opts)).toBe(true);
  });

  it('tells the tile server only the program and its version', () => {
    expect(mapTileUserAgent('0.1.0')).toBe('PhotoTool/0.1.0');
  });

  it('sends a tile request with only Accept and the program as User-Agent', () => {
    const chromium = {
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140 Electron/45.4.1 Photo Tool/0.1.0',
      'Accept-Language': 'en-CA,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      Referer: 'http://127.0.0.1:51234/',
      Cookie: 'a=1',
      'sec-ch-ua': '"Chromium";v="140"',
      'sec-ch-ua-mobile': '?0',
      'Sec-CH-UA-Platform': '"Windows"',
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Dest': 'image',
      DNT: '1',
      'X-Client-Data': 'abc',
      Origin: 'http://127.0.0.1:51234',
    };
    expect(mapTileRequestHeaders(chromium, '0.1.0')).toEqual({ Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', 'User-Agent': 'PhotoTool/0.1.0' });
    // Any spelling of Accept is kept as given; nothing else, even with no Accept at all.
    expect(mapTileRequestHeaders({ accept: 'image/*', 'sec-ch-ua-arch': 'x86' }, '1.2.3')).toEqual({ accept: 'image/*', 'User-Agent': 'PhotoTool/1.2.3' });
    expect(mapTileRequestHeaders({}, '1.2.3')).toEqual({ 'User-Agent': 'PhotoTool/1.2.3' });
  });

  it("looks up no name but the tile server's and GitHub's (for updates)", () => {
    const none = 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost';
    expect(hostResolverRules()).toBe(none);
    expect(mapHostResolverRules()).toBe(hostResolverRules(['tile.openstreetmap.org', ...UPDATE_HOSTS]));
    expect(mapHostResolverRules()).toBe(`${none}, EXCLUDE tile.openstreetmap.org, EXCLUDE github.com, EXCLUDE api.github.com, EXCLUDE objects.githubusercontent.com, EXCLUDE release-assets.githubusercontent.com`);
  });
});

describe('the remembered map answer', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is null until asked, then what was chosen; other settings are kept', () => {
    dir = mkdtempSync(join(tmpdir(), 'gallery-settings-'));
    const file = join(dir, 'settings.json');
    expect(readMapConsent(file)).toBe(null);
    writeMapConsent(file, true);
    expect(readMapConsent(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ mapsOnline: true });
    writeFileSync(file, JSON.stringify({ other: 1, mapsOnline: true }));
    writeMapConsent(file, false);
    expect(readMapConsent(file)).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ other: 1, mapsOnline: false });
  });

  it('reads nonsense as not asked yet, and replaces it', () => {
    dir = mkdtempSync(join(tmpdir(), 'gallery-settings-'));
    const file = join(dir, 'settings.json');
    writeFileSync(file, '{ broken');
    expect(readMapConsent(file)).toBe(null);
    writeFileSync(file, JSON.stringify({ mapsOnline: 'yes' }));
    expect(readMapConsent(file)).toBe(null);
    writeFileSync(file, '[]');
    expect(readMapConsent(file)).toBe(null);
    writeMapConsent(file, true);
    expect(readMapConsent(file)).toBe(true);
  });
});

describe('photos on the map', () => {
  const item = (path: string, lat: number | null, lon: number | null) => ({ path, fileName: path, relDir: '', effectiveDate: null, width: 1, height: 1, size: 1, effectiveLat: lat, effectiveLon: lon, info: {}, analysis: null });

  it('keeps the photos with a usable location and counts the rest', () => {
    const items = [
      item('a', 49.28, -123.12),
      item('b', null, null),
      item('c', 0, 0),
      item('d', Number.NaN, 10),
      item('e', 91, 10),
      item('f', 10, -181),
      item('g', -90, 180),
      item('h', 10, null),
      item('i', Infinity, 0),
    ];
    const { located, missing } = locatedItems(items);
    expect(located.map((i) => i.path)).toEqual(['a', 'c', 'g']);
    expect(missing).toBe(6);
  });

  it('says how many have no location', () => {
    expect(noLocationText(0)).toBe('');
    expect(noLocationText(1)).toBe('1 photo has no location');
    expect(noLocationText(1234)).toBe('1,234 photos have no location');
  });
});
