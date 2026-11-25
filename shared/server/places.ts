import { readFileSync } from 'node:fs';
import * as shared from './placesLogic';
import { worldAtlasFile } from './resources';

// Place outlines (logic in shared/server/placesLogic.ts), from the bundled world-atlas topology.

let places: shared.Place[] | null = null;

/** Detailed outlines (for drawing). */
const detailed = () => (places ??= shared.placesFromTopology(JSON.parse(readFileSync(worldAtlasFile(), 'utf8')) as shared.PlacesTopology));

export const listPlaces = () => shared.listPlaces(detailed());
export const placeOutline = (id: string) => shared.placeOutline(detailed(), id);
export const suggestPlaces = (points: [number, number][]) => shared.suggestPlaces(detailed(), points);
