// Import-graph tools for the program split: which files a set of entry points reaches through
// relative imports, and which relative imports leave a folder. Used by tests and by the plan.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.css', '.json', '.html'];
const SCANNED = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|html)$/;

const CODE_PATTERNS = [
  /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
  /\bnew\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g,
];
const HTML_PATTERN = /<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;

const toPosix = (p: string) => p.split(sep).join('/');

/** Relative specifiers written in a file. */
function specifiersOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const patterns = file.endsWith('.html') ? [HTML_PATTERN] : CODE_PATTERNS;
  const found: string[] = [];
  for (const pattern of patterns) {
    for (const m of text.matchAll(pattern)) {
      const spec = m[1].replace(/[?#].*$/, '');
      if (spec.startsWith('./') || spec.startsWith('../')) found.push(spec);
    }
  }
  return found;
}

const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

/** Resolve a relative specifier to an absolute file path, or null if nothing matches. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  if (isFile(base)) return base;
  for (const ext of EXTENSIONS) if (isFile(base + ext)) return base + ext;
  // TypeScript style: './x.js' written for './x.ts'.
  const stripped = base.replace(/\.(?:js|mjs|cjs)$/, '');
  if (stripped !== base) for (const ext of EXTENSIONS) if (isFile(stripped + ext)) return stripped + ext;
  for (const ext of EXTENSIONS) if (isFile(join(base, 'index' + ext))) return join(base, 'index' + ext);
  return null;
}

const inNodeModules = (p: string) => toPosix(p).split('/').includes('node_modules');

/** Every file reached from `entries` (repo-relative) through relative imports, entries included. */
export function importClosure(entries: string[], root: string): Set<string> {
  const absRoot = resolve(root);
  const seen = new Set<string>();
  const queue = entries.map((e) => resolve(absRoot, e));
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || inNodeModules(file) || !isFile(file)) continue;
    seen.add(file);
    if (!SCANNED.test(file)) continue;
    for (const spec of specifiersOf(file)) {
      const target = resolveSpecifier(file, spec);
      if (target && !inNodeModules(target)) queue.push(target);
    }
  }
  return new Set([...seen].map((f) => toPosix(relative(absRoot, f))));
}

const BARE_PATTERNS = [...CODE_PATTERNS.slice(0, 3), /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g];
// A style sheet's @import of a package's styles (the fonts: '@fontsource/inter/400.css').
const CSS_IMPORT = /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g;

/** The npm package a bare specifier names ('react-dom/client' → 'react-dom', '@a/b/c' → '@a/b'), or null for a relative path or a Node built-in. */
function packageOf(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || /^[a-z]:/i.test(spec)) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? (parts.length > 1 ? `${parts[0]}/${parts[1]}` : null) : parts[0]!;
}

/**
 * The npm packages the code reached from `entries` imports by name (`import 'x'`, `import('x')`,
 * `require('x')`, a style sheet's `@import 'x/…'`), type-only imports included: what a bundle of
 * those entries can carry. Throws when an entry is not a file: importClosure would skip it, and every
 * package only it reaches would quietly go missing from the list.
 */
export function packageImports(entries: string[], root: string): Set<string> {
  const missing = entries.filter((e) => !isFile(resolve(root, e)));
  if (missing.length) throw new Error(`Entry files not found: ${missing.join(', ')}`);
  const found = new Set<string>();
  for (const rel of importClosure(entries, root)) {
    const css = rel.endsWith('.css');
    if (!css && !/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(rel)) continue;
    const text = readFileSync(resolve(root, rel), 'utf8');
    for (const pattern of css ? [CSS_IMPORT] : BARE_PATTERNS) {
      for (const m of text.matchAll(pattern)) {
        const name = packageOf(m[1].replace(/[?#].*$/, ''));
        if (name) found.add(name);
      }
    }
  }
  return found;
}

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCANNED.test(name)) out.push(full);
  }
}

const within = (rel: string, folder: string) => {
  const f = folder.replace(/\/+$/, '');
  return rel === f || rel.startsWith(f + '/');
};

/** Relative imports in each rule's `from` folder that land outside it and outside its `mayImport` folders. */
export function crossings(
  root: string,
  rules: { from: string; mayImport: string[] }[],
): { file: string; imports: string }[] {
  const absRoot = resolve(root);
  const result: { file: string; imports: string }[] = [];
  for (const rule of rules) {
    const files: string[] = [];
    walk(resolve(absRoot, rule.from), files);
    for (const file of files.sort()) {
      for (const spec of specifiersOf(file)) {
        const target = resolveSpecifier(file, spec);
        if (!target) continue;
        const rel = toPosix(relative(absRoot, target));
        if (within(rel, rule.from) || rule.mayImport.some((m) => within(rel, m))) continue;
        result.push({ file: toPosix(relative(absRoot, file)), imports: rel });
      }
    }
  }
  return result;
}
