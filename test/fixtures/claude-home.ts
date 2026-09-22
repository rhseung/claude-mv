import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mangle } from '../../src/core/mangle.js';

import type { ScanTarget } from '../../src/core/scan.js';

export type ProjectSpec = {
  path: string;
  sessions?: Record<string, unknown[]>;
  subagents?: Record<string, Record<string, unknown[]>>;
  dirNameOverride?: string;
};

export type HomeSpec = {
  projects?: ProjectSpec[];
  configProjects?: string[];
  githubRepoPaths?: Record<string, string[]>;
  history?: { project: string; count: number }[];
  cacheFor?: string[];
  sessions?: { pid: number; cwd: string; sessionId?: string; procStart?: string }[];
};

export function createFakeClaudeHome(spec: HomeSpec = {}): ScanTarget & { home: string } {
  const home = mkdtempSync(join(tmpdir(), 'claude-mv-home-'));
  const projectsDir = join(home, 'projects');
  const sessionsDir = join(home, 'sessions');
  const cacheRoot = join(home, 'cache');
  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(cacheRoot, { recursive: true });

  for (const project of spec.projects ?? []) {
    const dir = join(projectsDir, project.dirNameOverride ?? mangle(project.path));
    mkdirSync(dir, { recursive: true });

    for (const [sessionId, lines] of Object.entries(project.sessions ?? {})) {
      writeFileSync(join(dir, `${sessionId}.jsonl`), toJsonl(lines));
    }
    for (const [sessionId, agents] of Object.entries(project.subagents ?? {})) {
      const agentDir = join(dir, sessionId, 'subagents');
      mkdirSync(agentDir, { recursive: true });
      for (const [agentId, lines] of Object.entries(agents)) {
        writeFileSync(join(agentDir, `${agentId}.jsonl`), toJsonl(lines));
        writeFileSync(join(agentDir, `${agentId}.meta.json`), JSON.stringify({ agentType: 'x' }));
      }
    }
  }

  const configPath = join(home, '.claude.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      projects: Object.fromEntries(
        (spec.configProjects ?? []).map((p) => [p, { hasTrustDialogAccepted: true }]),
      ),
      githubRepoPaths: spec.githubRepoPaths ?? {},
    }),
  );

  const historyPath = join(home, 'history.jsonl');
  writeFileSync(
    historyPath,
    toJsonl(
      (spec.history ?? []).flatMap(({ project, count }) =>
        Array.from({ length: count }, (_, i) => ({ project, display: `cmd ${i}` })),
      ),
    ),
  );

  for (const path of spec.cacheFor ?? []) {
    mkdirSync(join(cacheRoot, mangle(path), 'mcp-logs-test'), { recursive: true });
  }

  for (const s of spec.sessions ?? []) {
    writeFileSync(
      join(sessionsDir, `${s.pid}.json`),
      JSON.stringify({ sessionId: 'sid', ...s, pidDomain: 'darwin' }),
    );
  }

  return { home, projectsDir, configPath, historyPath, sessionsDir, cacheRoot };
}

function toJsonl(lines: unknown[]): string {
  return lines.length === 0 ? '' : `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}
