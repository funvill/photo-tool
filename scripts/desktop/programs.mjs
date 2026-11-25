// The two desktop programs the build scripts know, and the `--program <name>` argument that picks one.

export const PROGRAM_NAMES = ['photo-tool', 'photobook-editor'];

/**
 * The program named by `--program <name>` in `argv`. Throws when it is missing or unknown, so a build
 * never quietly builds the wrong program.
 */
export function programArg(argv) {
  const i = argv.indexOf('--program');
  const name = i >= 0 ? argv[i + 1] : undefined;
  if (!name || name.startsWith('--')) throw new Error(`--program is required: ${PROGRAM_NAMES.join(' or ')}.`);
  if (!PROGRAM_NAMES.includes(name)) throw new Error(`Unknown program "${name}": --program takes ${PROGRAM_NAMES.join(' or ')}.`);
  return name;
}

/** `argv` without `--program <name>`: what is left is for the program itself. */
export function withoutProgramArg(argv) {
  const i = argv.indexOf('--program');
  return i < 0 ? [...argv] : [...argv.slice(0, i), ...argv.slice(i + 2)];
}
