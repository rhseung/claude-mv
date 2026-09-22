import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import envPaths from 'env-paths';

/**
 * 이 파일만 process.env 와 os.homedir() 를 읽는다. 다른 곳은 전부 인자로 받는다.
 * 사용자의 ~/.claude 를 고치는 도구라, 경로 해석이 한 군데라도 새면 테스트가 진짜 홈을
 * 건드리게 된다. eslint 의 no-restricted-syntax 규칙이 이 경계를 강제한다.
 */
export type ClaudeEnv = {
  /** `~/.claude` 또는 CLAUDE_CONFIG_DIR. */
  claudeHome: string;
  /** `~/.claude.json` 상당. 아래 resolveConfigPath 참고 - 단순히 홈 아래가 아니다. */
  configPath: string;
  /** `<claudeHome>/projects`. */
  projectsDir: string;
  /** `<claudeHome>/history.jsonl`. */
  historyPath: string;
  /** `<claudeHome>/sessions`. 실행 중 프로세스 레지스트리. */
  sessionsDir: string;
  /** `<claudeHome>/plans`. 프로젝트별이 아니라 평평한 전역 디렉터리다. */
  plansDir: string;
  /** MCP 디버그 로그 캐시 루트. 없으면 null. */
  cacheRoot: string | null;
  /** 우리가 백업과 저널을 두는 곳. */
  toolDir: string;
  platform: NodeJS.Platform;
};

type RawEnv = {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
};

function readRawEnv(): RawEnv {
  return { env: process.env, home: homedir(), platform: process.platform };
}

/**
 * Claude Code 가 claudeHome 을 NFC 로 정규화한다. 경로에 비ASCII 가 들어 있을 때
 * NFD 로 둔 채 mangling 하면 대시 개수가 달라져 전혀 다른 디렉터리 이름이 나온다.
 */
function resolveClaudeHome(raw: RawEnv): string {
  return (raw.env.CLAUDE_CONFIG_DIR ?? join(raw.home, '.claude')).normalize('NFC');
}

/**
 * config 파일 위치는 2 단계다.
 *
 * 1. `<claudeHome>/.config.json` 이 있으면 그걸 쓴다.
 * 2. 없으면 `<CLAUDE_CONFIG_DIR ?? home>/.claude<접미사>.json`.
 *
 * 접미사는 prod 빌드에서 빈 문자열이지만 staging/local oauth 빌드에서는
 * `-staging-oauth` 같은 값이 붙는다. 우리는 Claude Code 쪽 환경을 알 수 없으므로
 * 기본 이름을 먼저 보고, 없으면 같은 디렉터리에서 변종을 찾는다.
 */
function resolveConfigPath(raw: RawEnv, claudeHome: string): string {
  const preferred = join(claudeHome, '.config.json');
  if (existsSync(preferred)) return preferred;

  const base = raw.env.CLAUDE_CONFIG_DIR ?? raw.home;
  const plain = join(base, '.claude.json');
  if (existsSync(plain)) return plain;

  const variant = safeReaddir(base).find(
    (name) => name.startsWith('.claude-') && name.endsWith('-oauth.json'),
  );
  return variant ? join(base, variant) : plain;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * MCP 로그 캐시 루트. Claude Code 가 `env-paths('claude-cli')` 를 쓰는 것이
 * 바이너리에서 확인됐으므로 같은 패키지를 부른다 - 플랫폼별 경로를 직접 짜맞추면
 * Windows 의 `\Cache` 접미사 같은 데서 어긋난다.
 *
 * 존재하지 않으면 null 을 준다. 내용이 버려도 되는 디버그 로그라서, 못 찾았을 때
 * 새로 만들지 않고 조용히 건너뛰는 편이 낫다.
 */
function resolveCacheRoot(): string | null {
  const root = envPaths('claude-cli').cache;
  return existsSync(root) ? root : null;
}

export function resolveClaudeEnv(overrides?: { claudeHome?: string }): ClaudeEnv {
  const raw = readRawEnv();
  const claudeHome = overrides?.claudeHome
    ? overrides.claudeHome.normalize('NFC')
    : resolveClaudeHome(raw);

  return {
    claudeHome,
    configPath: resolveConfigPath(raw, claudeHome),
    projectsDir: join(claudeHome, 'projects'),
    historyPath: join(claudeHome, 'history.jsonl'),
    sessionsDir: join(claudeHome, 'sessions'),
    plansDir: join(claudeHome, 'plans'),
    cacheRoot: resolveCacheRoot(),
    toolDir: join(claudeHome, '.claude-mv'),
    platform: raw.platform,
  };
}

/** CLI 가 보는 환경 값. 이것도 여기서만 읽는다. */
export type CliEnv = {
  ci: boolean;
  term: string | undefined;
  picker: string | undefined;
  isStdoutTTY: boolean;
  isStdinTTY: boolean;
};

export function readCliEnv(): CliEnv {
  return {
    ci: Boolean(process.env.CI),
    term: process.env.TERM,
    picker: process.env.CLAUDE_MV_PICKER,
    isStdoutTTY: Boolean(process.stdout.isTTY),
    isStdinTTY: Boolean(process.stdin.isTTY),
  };
}
