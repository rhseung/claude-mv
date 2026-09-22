import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

type PlatformPath = typeof path.posix;

export type CasePolicy = 'sensitive' | 'insensitive';

export function defaultCasePolicy(platform: NodeJS.Platform): CasePolicy {
  if (platform === 'win32') return 'insensitive';
  if (platform === 'darwin') return 'insensitive';
  return 'sensitive';
}

export function probeCasePolicy(dir: string, fallback: CasePolicy): CasePolicy {
  const flipped = flipCase(dir);
  if (flipped === dir) return fallback;
  try {
    const a = statSync(dir);
    const b = statSync(flipped);
    return a.ino === b.ino && a.dev === b.dev ? 'insensitive' : 'sensitive';
  } catch {
    return 'sensitive';
  }
}

function flipCase(input: string): string {
  return input.replace(/[a-zA-Z]/, (c) =>
    c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(),
  );
}

export type NormalizeOptions = {
  platform: NodeJS.Platform;
  home: string;
  realpath?: boolean;
};

export function normalizePath(input: string, opts: NormalizeOptions): string {
  const p = opts.platform === 'win32' ? path.win32 : path.posix;

  let out = input;
  if (out === '~') out = opts.home;
  else if (out.startsWith('~/') || (opts.platform === 'win32' && out.startsWith('~\\'))) {
    out = p.join(opts.home, out.slice(2));
  }

  if (opts.platform === 'win32') {
    out = stripLongPathPrefix(out);
  }

  out = p.resolve(out);

  if (opts.realpath !== false) {
    try {
      out = realpathSync.native(out);
      if (opts.platform === 'win32') out = stripLongPathPrefix(out);
    } catch {}
  }

  out = stripTrailingSeparator(out, p);
  if (opts.platform === 'win32') out = upperDriveLetter(out);

  return out;
}

function stripLongPathPrefix(input: string): string {
  if (input.startsWith('\\\\?\\UNC\\')) return `\\\\${input.slice(8)}`;
  if (input.startsWith('\\\\?\\')) return input.slice(4);
  return input;
}

function upperDriveLetter(input: string): string {
  return /^[a-z]:/.test(input) ? input[0]!.toUpperCase() + input.slice(1) : input;
}

function stripTrailingSeparator(input: string, p: PlatformPath): string {
  if (input === p.parse(input).root) return input;
  let out = input;
  while (out.length > 1 && (out.endsWith(p.sep) || out.endsWith('/'))) out = out.slice(0, -1);
  return out;
}

function fold(input: string, policy: CasePolicy): string {
  return policy === 'insensitive' ? input.replace(/[A-Z]/g, (c) => c.toLowerCase()) : input;
}

export function pathEquals(a: string, b: string, policy: CasePolicy): boolean {
  return fold(a, policy) === fold(b, policy);
}

export function isUnder(
  child: string,
  parent: string,
  policy: CasePolicy,
  platform: NodeJS.Platform = 'linux',
): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const a = fold(child, policy);
  const b = fold(parent, policy);
  const rel = p.relative(b, a);
  return Boolean(rel && rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
}

export function reparent(
  value: string,
  from: string,
  to: string,
  policy: CasePolicy,
  platform: NodeJS.Platform,
): string | undefined {
  const p = platform === 'win32' ? path.win32 : path.posix;

  if (!p.isAbsolute(value)) return undefined;

  if (pathEquals(value, from, policy)) return to;
  if (!isUnder(value, from, policy, platform)) return undefined;

  return p.join(to, value.slice(from.length));
}
