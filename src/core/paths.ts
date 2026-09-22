import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

type PlatformPath = typeof path.posix;

/**
 * 파일시스템이 대소문자를 구분하는지. mangling 은 대소문자를 보존하므로 이 정책은
 * "같은 디렉터리인가" 판정에만 쓰고, 디렉터리 이름을 만들 때는 절대 쓰지 않는다.
 */
export type CasePolicy = 'sensitive' | 'insensitive';

export function defaultCasePolicy(platform: NodeJS.Platform): CasePolicy {
  if (platform === 'win32') return 'insensitive';
  if (platform === 'darwin') return 'insensitive'; // APFS 기본값. probeCasePolicy 로 확정할 수 있다
  return 'sensitive';
}

/**
 * 실제 볼륨이 대소문자를 구분하는지 확인한다. macOS 는 대소문자 구분 볼륨을 만들 수 있어서
 * 플랫폼만 보고 단정할 수 없다. 아무것도 만들지 않고 stat 만 한다.
 */
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
  /** 심볼릭 링크를 푼다. mangling 에 쓸 값은 항상 true 여야 한다. */
  realpath?: boolean;
};

/**
 * 사용자가 친 경로를 Claude Code 가 저장했을 형태로 맞춘다.
 *
 * Claude Code 는 `process.cwd()` 를 그대로 mangling 하는데, POSIX 의 `getcwd` 는 심볼릭
 * 링크를 푼 값을 준다. 그래서 링크 경유로 들어온 경로를 그대로 쓰면 존재하지 않는
 * 디렉터리 이름을 만들게 된다.
 *
 * Windows 에서 주의할 점 둘:
 * - `\\?\` 접두사를 붙인 채 mangling 하면 `--?-C--...` 처럼 전혀 다른 이름이 된다. 떼어낸다.
 * - 드라이브 문자의 대소문자가 그대로 이름에 반영된다. `c:` 와 `C:` 가 다른 디렉터리가
 *   되므로 `process.cwd()` 가 주는 형태인 대문자로 맞춘다.
 */
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
    } catch {
      // 아직 없는 경로일 수 있다 (--state-only 로 이미 옮긴 뒤, 또는 이동 대상).
      // 그 경우 사전적 해석만으로 충분하다.
    }
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
  // 루트(`/`, `C:\`, `\\server\share\`)는 그대로 둬야 한다. 벗기면 빈 문자열이나
  // `C:` 가 되어 이후 join 이 엉뚱한 곳을 가리킨다.
  if (input === p.parse(input).root) return input;
  let out = input;
  while (out.length > 1 && (out.endsWith(p.sep) || out.endsWith('/'))) out = out.slice(0, -1);
  return out;
}

function fold(input: string, policy: CasePolicy): string {
  // 로케일 의존 소문자화를 쓰면 터키어 로케일에서 `I` 가 `ı` 가 되어
  // `C:\Users\Ilya` 같은 경로가 깨진다. ASCII 범위만 접는다.
  return policy === 'insensitive' ? input.replace(/[A-Z]/g, (c) => c.toLowerCase()) : input;
}

export function pathEquals(a: string, b: string, policy: CasePolicy): boolean {
  return fold(a, policy) === fold(b, policy);
}

/**
 * child 가 parent 아래에 있는지.
 *
 * `startsWith` 로 짜면 `/src-backup` 이 `/src` 하위로 잡히므로 경로 성분 단위로 따져야 한다.
 * is-path-inside 가 바로 그 일을 하지만 플랫폼을 인자로 받지 않아서, macOS 에서 도는
 * 테스트가 Windows 경로를 판정하지 못한다. 그래서 같은 방식(path.relative)을 쓰되
 * 경로 구현만 갈아끼울 수 있게 직접 둔다.
 */
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

/**
 * `from` 아래에 있는 경로를 `to` 아래로 옮긴 값. 대상이 아니면 undefined.
 *
 * 케이스 폴딩은 판정에만 쓰고 결과는 원본 대소문자를 살린 실제 문자열로 만든다.
 * 접은 문자열을 그대로 돌려주면 `/Users` 가 `/users` 로 바뀌어 저장된다.
 */
export function reparent(
  value: string,
  from: string,
  to: string,
  policy: CasePolicy,
  platform: NodeJS.Platform,
): string | undefined {
  const p = platform === 'win32' ? path.win32 : path.posix;

  // 트랜스크립트의 attachment 필드에는 상대 경로가 섞여 들어온다 (".zshrc",
  // ".local/share/chezmoi/Brewfile"). 상대 경로는 옮길 기준점이 없으므로 대상이 아니다.
  // 이 가드가 없으면 path.relative 가 양쪽을 process.cwd() 기준으로 풀어버려서,
  // 도구를 하필 src 안에서 실행했을 때 엉뚱한 값이 하위로 잡힌다.
  if (!p.isAbsolute(value)) return undefined;

  if (pathEquals(value, from, policy)) return to;
  if (!isUnder(value, from, policy, platform)) return undefined;

  return p.join(to, value.slice(from.length));
}
