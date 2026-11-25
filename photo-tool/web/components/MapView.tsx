import L from 'leaflet';
import 'leaflet.markercluster';
// Leaflet and its cluster plugin are bundled from npm, styles included: nothing comes from the internet but tiles.
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { locatedItems, noLocationText, OSM_ATTRIBUTION, OSM_TILE_URL } from '../../core/galleryMap';
import { desktop } from '../../../shared/web/desktop';
import { thumbUrl, type GalleryItem } from '../api';
import { loadMapConsent, saveMapConsent } from '../mapConsent';
import { useFilteredItems, useGallery } from '../store';

// Leaflet's default marker is a picture it would fetch. The map only draws its own markers (divIcons),
// so the default one points nowhere: it could never be drawn, and so never requested.
L.Icon.Default.imagePath = '';
L.Icon.Default.mergeOptions({ iconUrl: '', iconRetinaUrl: '', shadowUrl: '' });

export const MAP_PROMPT = 'The map is downloaded from OpenStreetMap over the internet. This shows OpenStreetMap roughly where you are looking. Load maps from the internet?';

const MARKER_PX = 36;
const CLUSTER_PX = 40;
const FIT = { padding: L.point(24, 24), maxZoom: 15, animate: false };

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * A photo's marker: its small thumbnail in a circle, outlined when it is the selected photo. Markup, not
 * an element: the picture is asked for only once Leaflet draws the marker (one in view, not merged into
 * a bubble), not for every located photo as the map opens.
 */
function markerIcon(item: GalleryItem, selected: boolean): L.DivIcon {
  const html = `<img src="${escapeHtml(thumbUrl(item.key, 's'))}" alt="${escapeHtml(item.fileName)}" loading="lazy" draggable="false">`;
  return L.divIcon({ className: selected ? 'gallery-map-marker selected' : 'gallery-map-marker', html, iconSize: L.point(MARKER_PX, MARKER_PX) });
}

interface Placed {
  marker: L.Marker;
  item: GalleryItem;
}

/**
 * The shown photos (the filter applied, stacks unfolded) on an OpenStreetMap map, each with a location as
 * a round thumbnail; photos close together merge into a bubble with a count, which a click splits. A click
 * on a photo selects it. The map's tiles come from the internet, so they load only once the user said
 * "Load maps" (asked here the first time); without them the markers sit on a plain background.
 */
export function MapView() {
  const items = useFilteredItems();
  const selected = useGallery((s) => s.selected);
  const { located, missing } = useMemo(() => locatedItems(items), [items]);
  /** undefined while the answer is being read; null when it was never asked. */
  const [consent, setConsent] = useState<boolean | null | undefined>(undefined);
  const [offline, setOffline] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const groupRef = useRef<L.MarkerClusterGroup | null>(null);
  const placed = useRef(new Map<string, Placed>());
  const marked = useRef<string | null>(null);
  const fitted = useRef(false);

  useEffect(() => {
    let live = true;
    void loadMapConsent(desktop).then((v) => live && setConsent(v));
    return () => {
      live = false;
    };
  }, []);

  // The map itself, once. The keys belong to the review (arrows step through the photos), not to panning.
  useEffect(() => {
    const el = box.current!;
    const map = L.map(el, { minZoom: 1, maxZoom: 19, keyboard: false, worldCopyJump: true, attributionControl: true, zoomControl: true });
    map.attributionControl.setPrefix(false);
    map.setView([20, 0], 2);
    const group = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 48,
      chunkedLoading: true,
      iconCreateFunction: (cluster) => L.divIcon({ className: 'gallery-map-cluster', html: `<span>${cluster.getChildCount()}</span>`, iconSize: L.point(CLUSTER_PX, CLUSTER_PX) }),
    });
    map.addLayer(group);
    mapRef.current = map;
    groupRef.current = group;
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      groupRef.current = null;
      placed.current.clear();
      marked.current = null;
      fitted.current = false;
    };
  }, []);

  // One marker per located photo. A photo whose place and thumbnail are unchanged keeps its marker.
  useEffect(() => {
    const map = mapRef.current;
    const group = groupRef.current;
    if (!map || !group) return;
    const sel = useGallery.getState().selected;
    const want = new Map(located.map((i) => [i.path, i]));
    const gone: L.Marker[] = [];
    for (const [path, p] of placed.current) {
      const next = want.get(path);
      if (next && next.key === p.item.key && next.effectiveLat === p.item.effectiveLat && next.effectiveLon === p.item.effectiveLon) {
        p.item = next;
        continue;
      }
      gone.push(p.marker);
      placed.current.delete(path);
    }
    if (gone.length) group.removeLayers(gone);
    const added: L.Marker[] = [];
    for (const item of located) {
      if (placed.current.has(item.path)) continue;
      const marker = L.marker([item.effectiveLat!, item.effectiveLon!], { icon: markerIcon(item, item.path === sel), title: item.fileName, zIndexOffset: item.path === sel ? 1000 : 0 });
      marker.on('click', () => useGallery.getState().select(item.path));
      placed.current.set(item.path, { marker, item });
      added.push(marker);
    }
    if (added.length) group.addLayers(added);
    if (sel !== null && placed.current.has(sel)) marked.current = sel;
    // The map opens fitted to every marker.
    if (!fitted.current && located.length) {
      fitted.current = true;
      map.fitBounds(L.latLngBounds(located.map((i) => [i.effectiveLat!, i.effectiveLon!] as L.LatLngTuple)), FIT);
    }
  }, [located]);

  // The selected photo's marker is outlined; when it is off screen the map pans to it (the zoom stays).
  useEffect(() => {
    const map = mapRef.current;
    const before = marked.current;
    if (before !== null && before !== selected) {
      const p = placed.current.get(before);
      if (p) p.marker.setIcon(markerIcon(p.item, false)).setZIndexOffset(0);
      marked.current = null;
    }
    const p = selected === null ? undefined : placed.current.get(selected);
    if (!map || !p) return;
    if (marked.current !== selected) {
      p.marker.setIcon(markerIcon(p.item, true)).setZIndexOffset(1000);
      marked.current = selected;
    }
    const at = p.marker.getLatLng();
    if (!map.getBounds().contains(at)) map.panTo(at);
  }, [selected]);

  // The tiles, only while the user allows maps. A tile that fails (offline) says so over the markers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || consent !== true) return;
    const layer = L.tileLayer(OSM_TILE_URL, { maxZoom: 19, attribution: OSM_ATTRIBUTION, referrerPolicy: 'no-referrer' });
    layer.on('tileerror', () => setOffline(true));
    layer.on('tileload', () => setOffline(false));
    layer.addTo(map);
    return () => {
      layer.remove();
      setOffline(false);
    };
  }, [consent]);

  const choose = async (on: boolean) => {
    // Off at once; on only once the desktop app knows (its guard would refuse tiles asked for before).
    if (!on) setConsent(false);
    try {
      await saveMapConsent(desktop, on);
    } catch {
      useGallery.getState().toast('error', "Couldn't change the map setting.");
      if (on) return;
    }
    if (on) setConsent(true);
  };

  const note = noLocationText(missing);
  return (
    <div className="gallery-map">
      {note && <p className="muted gallery-map-note">{note}</p>}
      <div className="gallery-map-stage">
        <div ref={box} className="gallery-map-canvas" />
        {typeof consent === 'boolean' && (
          <button type="button" className="btn btn-small gallery-map-online" title={consent ? 'Stop loading maps from the internet' : 'Load maps from the internet'} onClick={() => void choose(!consent)}>
            Map: {consent ? 'online' : 'offline'}
          </button>
        )}
        {consent === true && offline && (
          <div className="gallery-map-offline" role="status">
            Map unavailable offline
          </div>
        )}
        {consent === null && (
          <div className="gallery-map-consent" role="region" aria-label="Online maps">
            <p>{MAP_PROMPT}</p>
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={() => void choose(true)}>
                Load maps
              </button>
              <button type="button" className="btn" onClick={() => void choose(false)}>
                Not now
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
