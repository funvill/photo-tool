// Draws a program's launcher icon (1024 px PNG).
//
//   npx tsx scripts/launcher/make-icon.ts <out.png> [--program photobook-editor|photo-tool]
//
// The editor (the default): a warm tile with a photo-book glyph. Photo Tool: a blue tile with a
// grid of photos and a star, so the two are told apart at a glance on a taskbar.
import sharp from 'sharp';

const args = process.argv.slice(2);
const out = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--program');
const i = args.indexOf('--program');
const program = i >= 0 ? args[i + 1] : 'photobook-editor';
if (!out || (program !== 'photobook-editor' && program !== 'photo-tool')) {
  console.error('Usage: npx tsx scripts/launcher/make-icon.ts <out.png> [--program photobook-editor|photo-tool]');
  process.exit(1);
}

const editor = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f2b871"/><stop offset="1" stop-color="#c8693a"/></linearGradient>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe3b8"/><stop offset="1" stop-color="#ffd08c"/></linearGradient>
  </defs>
  <rect x="80" y="80" width="864" height="864" rx="196" fill="url(#bg)"/>
  <g transform="translate(512 540)">
    <path d="M-330 -210 Q-170 -250 -12 -200 L-12 250 Q-170 200 -330 240 Z" fill="#fffaf2"/>
    <path d="M330 -210 Q170 -250 12 -200 L12 250 Q170 200 330 240 Z" fill="#fffaf2"/>
    <rect x="-290" y="-160" width="240" height="260" rx="10" fill="url(#sky)"/>
    <circle cx="-120" cy="-90" r="34" fill="#f07a47"/>
    <path d="M-290 100 L-220 10 L-170 60 L-120 -10 L-50 100 Z" fill="#3d5568"/>
    <rect x="50" y="-160" width="240" height="120" rx="10" fill="url(#sky)"/>
    <path d="M50 -40 L120 -110 L170 -70 L215 -120 L290 -40 Z" fill="#3d5568"/>
    <rect x="50" y="-15" width="240" height="18" rx="9" fill="#d9c7ae"/>
    <rect x="50" y="25" width="180" height="18" rx="9" fill="#d9c7ae"/>
    <rect x="50" y="65" width="210" height="18" rx="9" fill="#d9c7ae"/>
  </g>
</svg>`;

/** One photo tile of Photo Tool's grid: a sky, a sun and a hill. */
const tile = (x: number, y: number) => `
    <g transform="translate(${x} ${y})">
      <rect width="250" height="250" rx="22" fill="#eaf4ff"/>
      <circle cx="175" cy="72" r="28" fill="#ffc94d"/>
      <path d="M0 250 L0 190 L80 110 L150 175 L190 140 L250 195 L250 250 Z" fill="#2f6f8f"/>
      <rect width="250" height="250" rx="22" fill="none" stroke="#ffffff" stroke-width="10"/>
    </g>`;

const photoTool = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5fb4e8"/><stop offset="1" stop-color="#2a5d9f"/></linearGradient>
  </defs>
  <rect x="80" y="80" width="864" height="864" rx="196" fill="url(#bg)"/>
  ${tile(232, 232)}${tile(542, 232)}${tile(232, 542)}${tile(542, 542)}
  <path transform="translate(667 667) scale(1.6)" d="M0 -100 L29 -40 L95 -31 L47 15 L59 81 L0 50 L-59 81 L-47 15 L-95 -31 L-29 -40 Z" fill="#ffd23f" stroke="#ffffff" stroke-width="12" stroke-linejoin="round"/>
</svg>`;

await sharp(Buffer.from(program === 'photo-tool' ? photoTool : editor)).png().toFile(out);
