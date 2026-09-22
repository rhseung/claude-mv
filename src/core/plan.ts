import { join } from 'node:path';

import { mangle } from './mangle.js';
import { isUnder, pathEquals, reparent, type CasePolicy } from './paths.js';

import type { ClaudeIndex, ProjectDirInfo, SessionRecord, TranscriptInfo } from './scan.js';

export type MoveRequest = {
  src: string;
  dst: string;
  /** 디렉터리는 두고 상태만 옮긴다. 손으로 이미 옮긴 경우. */
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
      /** 이 파일이 들어 있는 project 디렉터리가 같이 옮겨지는지. */
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
  /** 서술 필드에 남는 경로 수. --rewrite-prose 를 켜지 않았을 때만 의미가 있다. */
  proseLeftBehind: number;
};

/**
 * src 아래 경로 때문에 바뀔 줄 수.
 *
 * census 가 경로별 **줄 수**를 들고 있으므로 매칭되는 경로가 하나면 정확하다.
 * 한 줄에 서로 다른 매칭 경로가 둘 이상 있으면 겹쳐 세어질 수 있어서 전체 줄 수로 자른다.
 * 정확한 수는 실제 재작성이 알려주고, 여기 값은 계획 화면용 상한이다.
 */
function affectedCount(t: TranscriptInfo, req: MoveRequest): number {
  let n = 0;
  for (const [path, lines] of t.paths) {
    if (reparent(path, req.src, req.dst, req.policy, req.platform) !== undefined) n += lines;
  }
  return Math.min(n, t.lines);
}

/**
 * 한 파일 안에 cwd 가 src 안팎으로 섞여 있는가.
 *
 * paths 가 아니라 cwds 로 따진다. paths 에는 플랜 경로와 attachment 경로가 섞여 있어서,
 * 그걸로 세면 플랜을 참조했을 뿐인 세션이 전부 혼재로 잘못 잡힌다.
 */
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
  /** 파일이 실제로 있는지. 플랜 경로는 트랜스크립트에 적혀만 있고 만들어지지 않은 게 흔하다. */
  fileExists: (path: string) => boolean;
  configPath: string;
  historyPath: string;
  projectsDir: string;
  plansDir: string;
  cacheRoot: string | null;
  /** src 디렉터리가 실제로 있는지. stateOnly 판정에 쓴다. */
  srcExists: boolean;
  /** dst 디렉터리가 이미 있는지. */
  dstExists: boolean;
  /**
   * 살아 있다고 판정된 세션 전부. 어떤 트랜스크립트를 건드리면 안 되는지 고르는 데 쓴다.
   * "막아야 하는가" 와는 다른 질문이라 아래 blockingSessions 와 따로 둔다 - 겸하게 하면
   * --allow-ancestors 로 통과시킨 세션까지 차단 사유가 되어버린다.
   */
  liveSessions: SessionRecord[];
  /** 진행을 막아야 하는 세션. lock 검사가 정책까지 적용해서 준다. */
  blockingSessions: SessionRecord[];
  /**
   * 살아 있는 세션의 트랜스크립트를 재작성 대상에서 뺀다.
   *
   * 라이브 파일을 rename 으로 갈아끼우면 그 세션이 이후에 쓰는 기록을 잃을 수 있다.
   * 그 세션의 cwd 자체가 옮겨지는 게 아니라면, 몇 줄의 과거 맥락을 옛 경로로 남겨두는
   * 편이 진행 중인 대화를 잃는 것보다 낫다.
   */
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
  // 손실 인코딩이라 서로 다른 두 경로가 같은 디렉터리 이름을 쓸 수 있다.
  if (srcMangled === dstMangled && !pathEquals(req.src, req.dst, req.policy)) {
    warnings.push({ kind: 'mangle-collision', other: req.dst });
  }

  if (!req.stateOnly && !ctx.srcExists) blockers.push({ kind: 'src-missing' });

  if (ctx.blockingSessions.length > 0) {
    blockers.push({ kind: 'locked', sessions: ctx.blockingSessions });
  }

  // --- 트랜스크립트와 project 디렉터리 ---
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
      // 부모 디렉터리에 자식 경로를 쓰는 세션이 들어 있는 경우다. 디렉터리는 그대로 두고
      // 해당 레코드만 고친다. 세션 하나를 두 디렉터리로 쪼개면 resume 이 깨진다.
      warnings.push({
        kind: 'rewritten-in-parent-dir',
        dirName: project.dirName,
        files: touched.length,
      });
    }

    const liveSessionIds = new Set(ctx.liveSessions.map((s) => s.sessionId));

    for (const t of touched) {
      // 플랜 소유권은 트랜스크립트를 건너뛰든 말든 성립한다. 플랜 파일 자체는
      // 별도 파일이라 라이브 세션과 무관하게 고칠 수 있다.
      for (const path of t.paths.keys()) {
        if (isUnder(path, ctx.plansDir, req.policy, req.platform)) planFiles.add(path);
      }

      // 세션 본체만 건너뛴다. subagent 트랜스크립트는 에이전트가 끝나면 더 쓰이지
      // 않고, 안 옮기면 cwd 가 통째로 없는 경로를 가리키게 된다. 혹시 아직 도는
      // 에이전트가 있으면 동시 수정 감지가 잡는다.
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
    // 서브에이전트에게 "여기에 플랜을 써라" 고 알려준 경로가 트랜스크립트에 남지만
    // 실제로 만들어지지 않은 경우가 많다. 없는 파일을 계획에 넣으면 안 된다.
    if (!ctx.fileExists(file)) continue;

    // 플랜은 과거의 기록이 아니라 앞으로 따라야 할 지시서다. 낡은 경로를 남기면
    // 그대로 틀린 일을 하게 되므로 서술 필드와 달리 기본으로 고친다.
    steps.push({ kind: 'rewrite-plan', id: `plan:${file}`, file });
  }

  // --- ~/.claude.json ---
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

  // --- history.jsonl ---
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

  // --- MCP 로그 캐시 ---
  if (ctx.cacheRoot && ctx.index.cacheDirs.includes(srcMangled)) {
    steps.push({
      kind: 'move-cache-dir',
      id: 'mcp-logs',
      from: join(ctx.cacheRoot, srcMangled),
      to: join(ctx.cacheRoot, dstMangled),
    });
  }

  // --- 실제 디렉터리 ---
  // 같은 파일시스템이면 rename 한 번이라 가장 좋은 커밋 지점이다. 그래서 맨 뒤에 둔다.
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

/** 서술 필드에 그대로 남을 줄 수. 계획 화면에서 "이만큼은 두고 갑니다" 로 보여준다. */
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
