import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFakeClaudeHome } from './fixtures/claude-home.js';
import { records } from './fixtures/transcript.js';
import { diff, exists, snapshot } from './fixtures/tree.js';
import { apply, backupRoot } from '../src/core/apply.js';
import { createBackup } from '../src/core/backup.js';
import { Journal } from '../src/core/journal.js';
import { mangle } from '../src/core/mangle.js';
import { buildPlan, type MoveRequest } from '../src/core/plan.js';
import { rollback } from '../src/core/rollback.js';
import { scan } from '../src/core/scan.js';

const SRC_NAME = 'old-name';
const DST_NAME = 'new-name';

async function setup() {
  const seed = createFakeClaudeHome({});
  const work = join(seed.home, 'work');
  const src = join(work, SRC_NAME);
  const dst = join(work, DST_NAME);
  mkdirSync(join(src, 'sub'), { recursive: true });
  writeFileSync(join(src, 'README.md'), '# hello\n');

  // 플랜 소유권은 트랜스크립트의 planFilePath 구조 필드로만 성립한다.
  // 경로 문자열로 전역 플랜 디렉터리를 훑으면 남의 플랜을 건드리게 된다.
  const planFile = join(seed.home, 'plans', 'a-plan.md');

  const target = createFakeClaudeHome({
    projects: [
      {
        path: src,
        sessions: { s1: [records.user(src), records.pathless(), records.withPlan(src, planFile)] },
      },
      {
        path: work,
        sessions: { s2: [records.user(work)] },
        subagents: { s2: { 'agent-1': [records.user(src)] } },
      },
    ],
    configProjects: [src, '/unrelated/keep'],
    githubRepoPaths: { 'me/repo': [src] },
    history: [
      { project: src, count: 3 },
      { project: '/unrelated/keep', count: 2 },
    ],
    cacheFor: [src],
  });

  const plansDir = join(seed.home, 'plans');
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(planFile, `작업 대상은 ${src}/sub 입니다.\n`);

  const request: MoveRequest = {
    src,
    dst,
    stateOnly: false,
    rewriteProse: false,
    policy: 'sensitive',
    platform: process.platform,
  };

  const index = await scan(target);
  const plan = buildPlan(request, {
    index,
    configPath: target.configPath,
    historyPath: target.historyPath,
    projectsDir: target.projectsDir,
    plansDir,
    cacheRoot: target.cacheRoot,
    fileExists: exists,
    srcExists: true,
    dstExists: false,
    liveSessions: [],
  });

  return { home: target, work, src, dst, plan, planFile, plansDir };
}

function run(ctx: Awaited<ReturnType<typeof setup>>, backupDirRoot: string) {
  const backup = createBackup({
    root: backupDirRoot,
    backupId: 'test-backup',
    version: '0.0.0',
    plan: ctx.plan,
  });
  const journal = Journal.resume(backup.journalPath);
  journal.append({ kind: 'begin', backupId: backup.id, plan: ctx.plan });
  return { backup, journal };
}

describe('apply', () => {
  it('상태와 디렉터리를 모두 옮긴다', async () => {
    const ctx = await setup();
    const root = backupRoot(join(ctx.home.home, '.claude-mv'));
    const { backup, journal } = run(ctx, root);

    const result = await apply({ plan: ctx.plan, backup, journal });
    expect(result.failed).toBeNull();

    // 실제 디렉터리
    expect(exists(ctx.dst)).toBe(true);
    expect(exists(ctx.src)).toBe(false);
    expect(readFileSync(join(ctx.dst, 'README.md'), 'utf8')).toBe('# hello\n');

    // project 디렉터리 이름
    expect(exists(join(ctx.home.projectsDir, mangle(ctx.dst)))).toBe(true);
    expect(exists(join(ctx.home.projectsDir, mangle(ctx.src)))).toBe(false);

    // 트랜스크립트 cwd
    const moved = readFileSync(join(ctx.home.projectsDir, mangle(ctx.dst), 's1.jsonl'), 'utf8');
    expect(moved).toContain(ctx.dst);
    expect(moved).not.toContain(`"${ctx.src}"`);

    // 부모 디렉터리의 subagent 는 제자리에서 고쳐진다
    const inParent = readFileSync(
      join(ctx.home.projectsDir, mangle(ctx.work), 's2', 'subagents', 'agent-1.jsonl'),
      'utf8',
    );
    expect(inParent).toContain(ctx.dst);

    // ~/.claude.json 은 해당 키만 바뀌고 나머지는 그대로
    const config = JSON.parse(readFileSync(ctx.home.configPath, 'utf8'));
    expect(Object.keys(config.projects)).toEqual([ctx.dst, '/unrelated/keep']);
    expect(config.githubRepoPaths['me/repo']).toEqual([ctx.dst]);

    // history 는 해당 줄만
    const history = readFileSync(ctx.home.historyPath, 'utf8');
    expect(history.split('\n').filter((l) => l.includes(ctx.dst))).toHaveLength(3);
    expect(history.split('\n').filter((l) => l.includes('/unrelated/keep'))).toHaveLength(2);

    // 플랜은 지시서라 기본으로 고친다
    expect(readFileSync(ctx.planFile, 'utf8')).toContain(`${ctx.dst}/sub`);

    // MCP 로그 캐시
    expect(exists(join(ctx.home.cacheRoot!, mangle(ctx.dst)))).toBe(true);
  });
});

describe('rollback', () => {
  it('apply 이후 트리를 바이트 단위로 되돌린다', async () => {
    const ctx = await setup();
    const root = backupRoot(join(ctx.home.home, '.claude-mv'));

    // 백업 디렉터리는 원래 트리 바깥에 둔다. 스냅샷이 백업 자신을 세면 안 된다.
    const before = snapshot(ctx.home.home);

    const { backup, journal } = run(ctx, root);
    const applied = await apply({ plan: ctx.plan, backup, journal });
    expect(applied.failed).toBeNull();

    const result = rollback({ backupDir: backup.dir });
    expect(result.ok).toBe(true);
    expect(result.residue).toEqual([]);

    const after = snapshot(ctx.home.home);
    // 백업 디렉터리 자체는 비교에서 뺀다.
    const ignore = (m: Map<string, string>) =>
      new Map([...m].filter(([p]) => !p.startsWith('.claude-mv')));

    expect(diff(ignore(before), ignore(after))).toEqual([]);
    expect(exists(ctx.src)).toBe(true);
    expect(exists(ctx.dst)).toBe(false);
  });

  it('봉인되지 않은 백업은 되돌릴 게 없다', async () => {
    const ctx = await setup();
    const root = backupRoot(join(ctx.home.home, '.claude-mv'));
    const backup = createBackup({
      root,
      backupId: 'unsealed',
      version: '0.0.0',
      plan: ctx.plan,
    });

    // sealed 를 쓰지 않았다는 건 커밋 장벽 전에 죽었다는 뜻이다.
    const result = rollback({ backupDir: backup.dir });
    expect(result.ok).toBe(true);
    expect(result.restored).toEqual([]);
    expect(exists(ctx.src)).toBe(true);
  });
});
