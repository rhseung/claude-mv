import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFakeClaudeHome } from './fixtures/claude-home.js';
import { noLocks } from './fixtures/scenario.js';
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

function fieldsIn<T>(file: string, field: string): T[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as Record<string, unknown>)[field])
    .filter((value): value is T => value !== undefined);
}

const cwdsIn = (file: string) => fieldsIn<string>(file, 'cwd');

async function setup() {
  const seed = createFakeClaudeHome({});
  const work = join(seed.home, 'work');
  const src = join(work, SRC_NAME);
  const dst = join(work, DST_NAME);
  mkdirSync(join(src, 'sub'), { recursive: true });
  writeFileSync(join(src, 'README.md'), '# hello\n');

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
  writeFileSync(planFile, `작업 대상은 ${join(src, 'sub')} 입니다.\n`);

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
    locks: noLocks,
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

    expect(exists(ctx.dst)).toBe(true);
    expect(exists(ctx.src)).toBe(false);
    expect(readFileSync(join(ctx.dst, 'README.md'), 'utf8')).toBe('# hello\n');

    expect(exists(join(ctx.home.projectsDir, mangle(ctx.dst)))).toBe(true);
    expect(exists(join(ctx.home.projectsDir, mangle(ctx.src)))).toBe(false);

    const moved = cwdsIn(join(ctx.home.projectsDir, mangle(ctx.dst), 's1.jsonl'));
    expect(moved).toContain(ctx.dst);
    expect(moved).not.toContain(ctx.src);

    const inParent = cwdsIn(
      join(ctx.home.projectsDir, mangle(ctx.work), 's2', 'subagents', 'agent-1.jsonl'),
    );
    expect(inParent).toContain(ctx.dst);

    const config = JSON.parse(readFileSync(ctx.home.configPath, 'utf8'));
    expect(Object.keys(config.projects)).toEqual([ctx.dst, '/unrelated/keep']);
    expect(config.githubRepoPaths['me/repo']).toEqual([ctx.dst]);

    const history = fieldsIn<string>(ctx.home.historyPath, 'project');
    expect(history.filter((project) => project === ctx.dst)).toHaveLength(3);
    expect(history.filter((project) => project === '/unrelated/keep')).toHaveLength(2);

    expect(readFileSync(ctx.planFile, 'utf8')).toContain(join(ctx.dst, 'sub'));

    expect(exists(join(ctx.home.cacheRoot!, mangle(ctx.dst)))).toBe(true);
  });
});

describe('rollback', () => {
  it('apply 이후 트리를 바이트 단위로 되돌린다', async () => {
    const ctx = await setup();
    const root = backupRoot(join(ctx.home.home, '.claude-mv'));

    const before = snapshot(ctx.home.home);

    const { backup, journal } = run(ctx, root);
    const applied = await apply({ plan: ctx.plan, backup, journal });
    expect(applied.failed).toBeNull();

    const result = rollback({ backupDir: backup.dir });
    expect(result.ok).toBe(true);
    expect(result.residue).toEqual([]);

    const after = snapshot(ctx.home.home);
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

    const result = rollback({ backupDir: backup.dir });
    expect(result.ok).toBe(true);
    expect(result.restored).toEqual([]);
    expect(exists(ctx.src)).toBe(true);
  });
});
