import sharp from 'sharp';
import type { MediaHandler } from './index';

// Formats sharp's bundled libvips decodes itself: the original is the working file, never copied.

export function sharpHandler(id: string): MediaHandler {
  return {
    id,
    preview: async (file) => file,
    image: async (file) => sharp(file, { failOn: 'none' }).rotate(),
  };
}
