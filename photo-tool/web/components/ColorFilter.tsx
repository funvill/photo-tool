import { colorMatrix, isNoAdjust, svgMatrixValues, type Adjust } from '../../../shared/core/colorAdjust';

// Light and colour on the page: an SVG feColorMatrix with the very numbers sharp applies when the photo is
// saved (core/colorAdjust.ts), worked in sRGB, as sharp works. Not CSS's brightness() and friends: their
// maths differs, and the saved photo would not match what was shown.

/** The filter's id for an adjustment: the same values share one id (each copy of it defines the same filter). */
export function colorFilterId(a: Adjust): string {
  return `pt-color-${[a.brightness, a.contrast, a.saturation, a.warmth].map((v) => String(Math.round(v * 100)).replace('-', 'm')).join('_')}`;
}

/** The CSS `filter` for an adjustment, or undefined when it changes nothing. Pair it with a <ColorFilter> of the same adjustment. */
export function colorFilterCss(a: Adjust | undefined): string | undefined {
  return isNoAdjust(a) ? undefined : `url(#${colorFilterId(a!)})`;
}

/** The SVG filter an adjustment draws with (nothing when it changes nothing). Takes no room. */
export function ColorFilter({ adjust }: { adjust: Adjust | undefined }) {
  if (isNoAdjust(adjust)) return null;
  return (
    <svg className="gallery-color-filter" width="0" height="0" aria-hidden="true" focusable="false">
      <filter id={colorFilterId(adjust!)} colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
        <feColorMatrix type="matrix" values={svgMatrixValues(colorMatrix(adjust!))} />
      </filter>
    </svg>
  );
}
