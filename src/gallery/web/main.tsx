import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// The bundled fonts and the shared base styles: served by this app, never fetched from the internet.
import '../../../shared/web/fonts.css';
import '../../../shared/web/base.css';
import './gallery.css';
import { GalleryApp } from './GalleryApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GalleryApp />
  </StrictMode>,
);
