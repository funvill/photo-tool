import { openSync, type Font } from 'fontkit';
import { fontFilePath } from '../core';
import { textOutline as outline, type OutlineRequest } from '../shared/textOutline';
import { fontFile } from '../../shared/server/resources';

// Text → vector outline (see src/shared/textOutline.ts), with the font files read from disk.

const fonts = new Map<string, Font>();

function font(family: string, weight: number, italic: boolean): Font {
  const file = fontFile(fontFilePath(family, weight, italic));
  let f = fonts.get(file);
  if (!f) {
    f = openSync(file);
    fonts.set(file, f);
  }
  return f;
}

export type { OutlineRequest };

export const textOutline = (req: OutlineRequest) => outline(font(req.fontFamily, req.fontWeight, !!req.italic), req);
