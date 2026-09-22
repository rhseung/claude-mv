import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import envPaths from 'env-paths';

export type ClaudeEnv = {
  claudeHome: string;
  configPath: string;
  projectsDir: string;
  historyPath: string;
  sessionsDir: string;
  plansDir: string;
  cacheRoot: string | null;
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

function resolveClaudeHome(raw: RawEnv): string {
  return (raw.env.CLAUDE_CONFIG_DIR ?? join(raw.home, '.claude')).normalize('NFC');
}

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
