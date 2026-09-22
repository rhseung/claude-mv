import { join } from 'node:path';

import { mangle } from './mangle.js';
import { isUnder, pathEquals, reparent, type CasePolicy } from './paths.js';

import type { LockReport } from './lock.js';
import type { ClaudeIndex, ProjectDirInfo, SessionRecord, TranscriptInfo } from './scan.js';

export type MoveRequest = {
  src: string;
  dst: string;
  stateOnly: boolean;
  rewriteProse: boolean;
  policy: CasePolicy;
  platform: NodeJS.Platform;
};

export type PlanStep =
  | { kind: 'move-directory'; id: string; from: string; to: string }
  | { kind: 'move-project-dir'; id: string; from: string; to: string; files: number }
  | {
      kind: 'rewrite-transcript';
      id: string;
      file: string;
      movesWithDir: boolean;
      affected: number;
      total: number;
    }
  | { kind: 'edit-config'; id: string; file: string; renameKey: boolean; githubRepos: string[] }
  | { kind: 'rewrite-history'; id: string; file: string; affected: number }
  | { kind: 'move-cache-dir'; id: string; from: string; to: string }
  | { kind: 'rewrite-plan'; id: string; file: string }
  | { kind: 'repair-worktrees'; id: string; repoRoot: string };

export type Blocker =
  | { kind: 'locked'; sessions: SessionRecord[] }
  | { kind: 'dst-project-dir-exists'; dirName: string }
  | { kind: 'dst-config-key-exists'; key: string }
  | { kind: 'src-missing' }
  | { kind: 'dst-inside-src' };

export type Warning =
  | { kind: 'mixed-cwd'; file: string; paths: string[] }
  | { kind: 'skipped-live'; sessionId: string }
  | { kind: 'rewritten-in-parent-dir'; dirName: string; files: number }
  | { kind: 'mangle-collision'; other: string }
  | { kind: 'nothing-to-do' };

export type MigrationPlan = {
  request: MoveRequest;
  steps: PlanStep[];
  blockers: Blocker[];
  warnings: Warning[];
  proseLeftBehind: number;
};

function affectedCount(t: TranscriptInfo, req: MoveRequest): number {
  let n = 0;
  for (const [path, lines] of t.paths) {
    if (reparent(path, req.src, req.dst, req.policy, req.platform) !== undefined) n += lines;
  }
  return Math.min(n, t.lines);
}

function isMixed(t: TranscriptInfo, req: MoveRequest): string[] {
  const inside: string[] = [];
  const outside: string[] = [];
  for (const path of t.cwds.keys()) {
    if (reparent(path, req.src, req.dst, req.policy, req.platform) !== undefined) inside.push(path);
    else outside.push(path);
  }
  return inside.length > 0 && outside.length > 0 ? [...inside, ...outside] : [];
}

export type PlanContext = {
  index: ClaudeIndex;
  fileExists: (path: string) => boolean;
  configPath: string;
  historyPath: string;
  projectsDir: string;
  plansDir: string;
  cacheRoot: string | null;
  srcExists: boolean;
  dstExists: boolean;
  locks: LockReport;
  skipLiveTranscripts?: boolean;
};

export function buildPlan(req: MoveRequest, ctx: PlanContext): MigrationPlan {
  const steps: PlanStep[] = [];
  const blockers: Blocker[] = [];
  const warnings: Warning[] = [];

  const srcMangled = mangle(req.src);
  const dstMangled = mangle(req.dst);

  if (isUnder(req.dst, req.src, req.policy, req.platform)) {
    blockers.push({ kind: 'dst-inside-src' });
  }
  if (srcMangled === dstMangled && !pathEquals(req.src, req.dst, req.policy)) {
    warnings.push({ kind: 'mangle-collision', other: req.dst });
  }

  if (!req.stateOnly && !ctx.srcExists) blockers.push({ kind: 'src-missing' });

  const blocking = ctx.locks.blocking.map((finding) => finding.session);
  if (blocking.length > 0) blockers.push({ kind: 'locked', sessions: blocking });

  const planFiles = new Set<string>();

  for (const project of ctx.index.projects) {
    const owns = project.dirName === srcMangled;
    const touched = project.transcripts.filter((t) => affectedCount(t, req) > 0);
    if (!owns && touched.length === 0) continue;

    if (owns) {
      if (ctx.index.projects.some((p) => p.dirName === dstMangled)) {
        blockers.push({ kind: 'dst-project-dir-exists', dirName: dstMangled });
      }
      steps.push({
        kind: 'move-project-dir',
        id: 'project-dir',
        from: project.dirPath,
        to: join(ctx.projectsDir, dstMangled),
        files: project.transcripts.length + project.otherFiles.length,
      });
    } else if (touched.length > 0) {
      warnings.push({
        kind: 'rewritten-in-parent-dir',
        dirName: project.dirName,
        files: touched.length,
      });
    }

    const liveSessionIds = new Set(
      ctx.locks.findings.filter((f) => f.verdict !== 'stale').map((f) => f.session.sessionId),
    );

    for (const t of touched) {
      for (const path of t.paths.keys()) {
        if (isUnder(path, ctx.plansDir, req.policy, req.platform)) planFiles.add(path);
      }

      if (ctx.skipLiveTranscripts && t.kind === 'session' && liveSessionIds.has(t.sessionId)) {
        warnings.push({ kind: 'skipped-live', sessionId: t.sessionId });
        continue;
      }

      const mixed = isMixed(t, req);
      if (mixed.length > 0) warnings.push({ kind: 'mixed-cwd', file: t.file, paths: mixed });

      steps.push({
        kind: 'rewrite-transcript',
        id: `transcript:${t.sessionId}${t.agentId ? `/${t.agentId}` : ''}`,
        file: t.file,
        movesWithDir: owns,
        affected: affectedCount(t, req),
        total: t.lines,
      });
    }
  }

  for (const file of planFiles) {
    if (!ctx.fileExists(file)) continue;

    steps.push({ kind: 'rewrite-plan', id: `plan:${file}`, file });
  }

  const located = locateInConfig(ctx.index, req);
  if (located.renameKey || located.githubRepos.length > 0) {
    if (located.dstKeyExists) blockers.push({ kind: 'dst-config-key-exists', key: req.dst });
    steps.push({
      kind: 'edit-config',
      id: 'claude-json',
      file: ctx.configPath,
      renameKey: located.renameKey,
      githubRepos: located.githubRepos,
    });
  }

  const historyAffected = [...ctx.index.historyProjects]
    .filter(([p]) => reparent(p, req.src, req.dst, req.policy, req.platform) !== undefined)
    .reduce((sum, [, n]) => sum + n, 0);
  if (historyAffected > 0) {
    steps.push({
      kind: 'rewrite-history',
      id: 'history',
      file: ctx.historyPath,
      affected: historyAffected,
    });
  }

  if (ctx.cacheRoot && ctx.index.cacheDirs.includes(srcMangled)) {
    steps.push({
      kind: 'move-cache-dir',
      id: 'mcp-logs',
      from: join(ctx.cacheRoot, srcMangled),
      to: join(ctx.cacheRoot, dstMangled),
    });
  }

  if (!req.stateOnly && ctx.srcExists) {
    steps.push({ kind: 'move-directory', id: 'working-tree', from: req.src, to: req.dst });
  }

  if (steps.length === 0) warnings.push({ kind: 'nothing-to-do' });

  const proseLeftBehind = req.rewriteProse ? 0 : countProse(ctx.index, req);

  return { request: req, steps, blockers, warnings, proseLeftBehind };
}

function locateInConfig(
  index: ClaudeIndex,
  req: MoveRequest,
): { renameKey: boolean; dstKeyExists: boolean; githubRepos: string[] } {
  return {
    renameKey: index.configProjectKeys.some((k) => pathEquals(k, req.src, req.policy)),
    dstKeyExists: index.configProjectKeys.some((k) => pathEquals(k, req.dst, req.policy)),
    githubRepos: Object.entries(index.githubRepoPaths)
      .filter(([, paths]) =>
        paths.some((p) => reparent(p, req.src, req.dst, req.policy, req.platform) !== undefined),
      )
      .map(([repo]) => repo),
  };
}

function countProse(index: ClaudeIndex, req: MoveRequest): number {
  let n = 0;
  for (const project of index.projects) {
    for (const t of project.transcripts) {
      for (const [path, lines] of t.prose) {
        if (reparent(path, req.src, req.dst, req.policy, req.platform) !== undefined) n += lines;
      }
    }
  }
  return n;
}

export function affectedProjects(plan: MigrationPlan, index: ClaudeIndex): ProjectDirInfo[] {
  const files = new Set(
    plan.steps.filter((s) => s.kind === 'rewrite-transcript').map((s) => s.file),
  );
  return index.projects.filter((p) => p.transcripts.some((t) => files.has(t.file)));
}
