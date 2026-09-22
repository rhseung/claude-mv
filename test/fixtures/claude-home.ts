import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mangle } from '../../src/core/mangle.js';

import type { ScanTarget } from '../../src/core/scan.js';

export type ProjectSpec = {
  /** 이 디렉터리가 키로 삼는 경로. mangle 해서 디렉터리 이름을 만든다. */
  path: string;
  /** 세션 파일별 레코드 목록. */
  sessions?: Record<string, unknown[]>;
  /** `<sessionId>/subagents/agent-<id>.jsonl`. */
  subagents?: Record<string, Record<string, unknown[]>>;
  /** 디렉터리 이름을 일부러 어긋나게 만든다 (key-mismatch 재현). */
  dirNameOverride?: string;
};

export type HomeSpec = {
  projects?: ProjectSpec[];
  /** ~/.claude.json 의 projects 키로 들어갈 경로들. */
  configProjects?: string[];
  githubRepoPaths?: Record<string, string[]>;
  history?: { project: string; count: number }[];
  /** 캐시 루트에 만들 프로젝트 경로들. */
  cacheFor?: string[];
  sessions?: { pid: number; cwd: string; sessionId?: string; procStart?: string }[];
};

/**
 * 가짜 ~/.claude 트리. 테스트가 진짜 홈을 건드리지 않게 하는 3 중 방어 중 하나다
 * (나머지 둘은 env.ts 로의 경로 해석 일원화와 test/setup.ts 의 HOME 격리).
 */
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
        // 실제로 딸려 있는 사이드카. JSONL 이 아니라 그대로 옮겨야 한다.
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
