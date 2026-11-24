import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// The editor's bundled fonts and styles: served by this app, never fetched from the internet.
import '../../web/fonts.css';
import '../../web/styles.css';
import { GalleryApp } from './GalleryApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GalleryApp />
  </StrictMode>,
);
