import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFakeClaudeHome, type HomeSpec } from './fixtures/claude-home.js';
import { noLocks } from './fixtures/scenario.js';
import { records } from './fixtures/transcript.js';
import { mangle } from '../src/core/mangle.js';
import { buildPlan, type MoveRequest, type PlanContext } from '../src/core/plan.js';
import { scan } from '../src/core/scan.js';

import type { LockFinding, LockReport } from '../src/core/lock.js';
import type { SessionRecord } from '../src/core/scan.js';

const SRC = '/Users/me/dev/old-name';
const DST = '/Users/me/dev/new-name';
const PARENT = '/Users/me/dev';

const request = (over: Partial<MoveRequest> = {}): MoveRequest => ({
  src: SRC,
  dst: DST,
  stateOnly: false,
  rewriteProse: false,
  policy: 'sensitive',
  platform: 'linux',
  ...over,
});

async function plan(
  spec: HomeSpec,
  over: Partial<MoveRequest> = {},
  ctx: Partial<PlanContext> = {},
) {
  const target = createFakeClaudeHome(spec);
  const index = await scan(target);
  return buildPlan(request(over), {
    index,
    configPath: target.configPath,
    historyPath: target.historyPath,
    projectsDir: target.projectsDir,
    plansDir: join(target.home, 'plans'),
    cacheRoot: target.cacheRoot,
    fileExists: () => true,
    srcExists: true,
    dstExists: false,
    locks: noLocks,
    ...ctx,
  });
}

const kinds = (p: Awaited<ReturnType<typeof plan>>) => p.steps.map((s) => s.kind);

function lockedBy(session: SessionRecord): LockReport {
  const finding: LockFinding = {
    session,
    verdict: 'live',
    relation: 'at-or-under',
    why: '실행 중입니다.',
  };
  return { findings: [finding], blocking: [finding] };
}

describe('buildPlan', () => {
  it('src 의 project 디렉터리는 통째로 옮긴다', async () => {
    const p = await plan({ projects: [{ path: SRC, sessions: { s1: [records.user(SRC)] } }] });

    const move = p.steps.find((s) => s.kind === 'move-project-dir');
    expect(move).toMatchObject({ to: expect.stringContaining(mangle(DST)) });
    expect(p.steps.find((s) => s.kind === 'rewrite-transcript')).toMatchObject({
      movesWithDir: true,
    });
  });

  it('부모 디렉터리는 옮기지 않고 해당 레코드만 고친다', async () => {
    const p = await plan({
      projects: [
        {
          path: PARENT,
          sessions: { s1: [records.user(PARENT)] },
          subagents: { s1: { 'agent-1': [records.user(SRC)] } },
        },
      ],
    });

    expect(kinds(p)).not.toContain('move-project-dir');
    expect(p.steps.find((s) => s.kind === 'rewrite-transcript')).toMatchObject({
      movesWithDir: false,
    });
    expect(p.warnings.map((w) => w.kind)).toContain('rewritten-in-parent-dir');
  });

  it('cwd 가 섞인 파일에 경고를 단다', async () => {
    const p = await plan({
      projects: [{ path: PARENT, sessions: { s1: [records.user(PARENT), records.user(SRC)] } }],
    });

    expect(p.warnings.find((w) => w.kind === 'mixed-cwd')).toBeDefined();
  });

  it('플랜 파일을 참조했을 뿐인 세션은 cwd 혼재가 아니다', async () => {
    const p = await plan({
      projects: [
        {
          path: SRC,
          sessions: { s1: [records.withPlan(SRC, '/Users/me/.claude/plans/some-plan.md')] },
        },
      ],
    });

    expect(p.warnings.map((w) => w.kind)).not.toContain('mixed-cwd');
  });

  it('플랜은 구조 필드로 찾고, 없는 파일은 넣지 않는다', async () => {
    const planPath = '/Users/me/.claude/plans/p.md';
    const spec: HomeSpec = {
      projects: [{ path: SRC, sessions: { s1: [records.withPlan(SRC, planPath)] } }],
    };

    const withFile = await plan(spec, {}, { plansDir: '/Users/me/.claude/plans' });
    expect(kinds(withFile)).toContain('rewrite-plan');

    const without = await plan(
      spec,
      {},
      { plansDir: '/Users/me/.claude/plans', fileExists: () => false },
    );
    expect(kinds(without)).not.toContain('rewrite-plan');
  });

  it('여섯 위치를 독립적으로 잡는다', async () => {
    const p = await plan({
      projects: [{ path: SRC, sessions: { s1: [records.user(SRC)] } }],
      configProjects: [SRC],
      history: [{ project: SRC, count: 4 }],
      cacheFor: [SRC],
    });

    expect(kinds(p)).toEqual(
      expect.arrayContaining([
        'move-project-dir',
        'rewrite-transcript',
        'edit-config',
        'rewrite-history',
        'move-cache-dir',
        'move-directory',
      ]),
    );
    expect(p.steps.find((s) => s.kind === 'rewrite-history')).toMatchObject({ affected: 4 });
  });

  it('실제 디렉터리 이동이 마지막 단계다', async () => {
    const p = await plan({
      projects: [{ path: SRC, sessions: { s1: [records.user(SRC)] } }],
      cacheFor: [SRC],
    });
    expect(kinds(p).at(-1)).toBe('move-directory');
  });

  it('--state-only 면 디렉터리를 건드리지 않는다', async () => {
    const p = await plan(
      { projects: [{ path: SRC, sessions: { s1: [records.user(SRC)] } }] },
      { stateOnly: true },
      { srcExists: false },
    );
    expect(kinds(p)).not.toContain('move-directory');
    expect(p.blockers).toHaveLength(0);
  });
});

describe('차단', () => {
  it('dst 가 src 안이면 막는다', async () => {
    const p = await plan({}, { dst: `${SRC}/inner` });
    expect(p.blockers.map((b) => b.kind)).toContain('dst-inside-src');
  });

  it('dst 의 project 디렉터리가 이미 있으면 막는다', async () => {
    const p = await plan({
      projects: [
        { path: SRC, sessions: { s1: [records.user(SRC)] } },
        { path: DST, sessions: { s2: [records.user(DST)] } },
      ],
    });
    expect(p.blockers.map((b) => b.kind)).toContain('dst-project-dir-exists');
  });

  it('살아 있는 세션이 있으면 막는다', async () => {
    const p = await plan(
      { projects: [{ path: SRC, sessions: { s1: [records.user(SRC)] } }] },
      {},
      { locks: lockedBy({ pid: 1, cwd: SRC, sessionId: 's', startedAtMs: 0 }) },
    );
    expect(p.blockers.map((b) => b.kind)).toContain('locked');
  });

  it('옮길 게 없으면 알려준다', async () => {
    const p = await plan({}, {}, { srcExists: false, stateOnly: true } as Partial<PlanContext>);
    expect(p.warnings.map((w) => w.kind)).toContain('nothing-to-do');
  });
});
