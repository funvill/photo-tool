import type { PhotoAnalysis } from './photoAnalysis';

type ID = string;

/** One photo in a project library; the gallery's sorts and the editor's drafts both read this shape. */
export interface PhotoAsset {
  id: ID;
  fileName: string;
  format: string;
  fileSizeBytes: number;
  /** Dimensions after EXIF orientation has been applied. */
  widthPx: number;
  heightPx: number;
  capturedAt: string | null;
  gpsLat: number | null;
  gpsLon: number | null;
  rating: number;
  favorite: boolean;
  tags: string[];
  /** From the folder's photoinfo.json (desktop editor only). */
  people?: string[];
  description?: string;
  /**
   * Desktop editor: the photo's folder or its photoinfo.json could not be read (folder offline or moved, file
   * broken), so its star and other info are unknown. Drafts neither add nor remove such a photo.
   */
  infoUnavailable?: boolean;
  contentHash: string;
  exactDuplicateOf: ID | null;
  analysis: PhotoAnalysis | null;
  /** Per-project: user excluded this photo from automatic drafts. */
  excluded: boolean;
  /** Original file could not be found at its recorded path. */
  missing: boolean;
}
