// Types for programs.mjs (plain JavaScript, so build.mjs can run it with node).
export type ProgramName = 'photo-tool' | 'photobook-editor';

export interface ProgramFiles {
  product: string;
  main: string;
  serverHost: string;
  preload: string;
  taggingWorker: string | null;
  page: string;
  external: string[];
}

export const PROGRAMS: Record<ProgramName, ProgramFiles>;
export const PROGRAM_NAMES: ProgramName[];
export function programEntries(name: ProgramName): string[];
export function programArg(argv: readonly string[]): ProgramName;
export function withoutProgramArg(argv: readonly string[]): string[];
