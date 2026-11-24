// Facts about a photo that the gallery shows next to the picture.

/** Camera settings read from EXIF. A field is left out when the file does not say. */
export interface PhotoExif {
  lens?: string;
  /** mm */
  focalLength?: number;
  /** mm, as a 35 mm film camera would need */
  focalLength35?: number;
  /** f-number */
  aperture?: number;
  /** seconds */
  exposureTime?: number;
  iso?: number;
  /** EV; may be 0 or negative */
  exposureBias?: number;
  flash?: boolean;
}
