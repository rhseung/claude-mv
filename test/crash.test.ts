import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFakeClaudeHome } from './fixtures/claude-home.js';
import { noLocks } from './fixtures/scenario.js';
import { records } from './fixtures/transcript.js';
import { diff, exists, snapshot } from './fixtures/tree.js';
import { apply, backupRoot } from '../src/core/apply.js';
import { createBackup } from '../src/core/backup.js';
import { Journal } from '../src/core/journal.js';
import { buildPlan, type MoveRequest } from '../src/core/plan.js';
import { rollback } from '../src/core/rollback.js';
import { scan } from '../src/core/scan.js';

async function buildScenario() {
  const seed = createFakeClaudeHome({});
  const work = join(seed.home, 'work');
  const src = join(work, 'old-name');
  const dst = join(work, 'new-name');
  mkdirSync(join(src, 'sub'), { recursive: true });
  writeFileSync(join(src, 'README.md'), '# hello\n');

  const planFile = join(seed.home, 'plans', 'p.md');
  const home = createFakeClaudeHome({
    projects: [
      {
        path: src,
        sessions: { s1: [records.user(src), records.withPlan(src, planFile)] },
      },
      {
        path: work,
        sessions: { s2: [records.user(work)] },
        subagents: { s2: { 'agent-1': [records.user(src)] } },
      },
    ],
    configProjects: [src, '/unrelated'],
    history: [{ project: src, count: 2 }],
    cacheFor: [src],
  });

  mkdirSync(join(seed.home, 'plans'), { recursive: true });
  writeFileSync(planFile, `대상은 ${src} 입니다.\n`);

  const request: MoveRequest = {
    src,
    dst,
    stateOnly: false,
    rewriteProse: false,
    policy: 'sensitive',
    platform: process.platform,
  };

  const index = await scan(home);
  const plan = buildPlan(request, {
    index,
    configPath: home.configPath,
    historyPath: home.historyPath,
    projectsDir: home.projectsDir,
    plansDir: join(seed.home, 'plans'),
    cacheRoot: home.cacheRoot,
    fileExists: exists,
    srcExists: true,
    dstExists: false,
    locks: noLocks,
  });

  return { home, plan, src, dst };
}

const ignoreBackups = (m: Map<string, string>) =>
  new Map([...m].filter(([p]) => !p.startsWith('.claude-mv')));

describe('크래시 주입', () => {
  it('계획에 단계가 충분히 있다', async () => {
    const { plan } = await buildScenario();
    expect(plan.steps.length).toBeGreaterThanOrEqual(6);
  });

  it('모든 커밋 지점에서 중단해도 원상복구된다', async () => {
    const probe = await buildScenario();
    const stepCount = probe.plan.steps.length;

    for (let failAt = 0; failAt < stepCount; failAt++) {
      const { home, plan } = await buildScenario();
      const before = ignoreBackups(snapshot(home.home));

      const root = backupRoot(join(home.home, '.claude-mv'));
      mkdirSync(root, { recursive: true });
      const backup = createBackup({ root, backupId: `crash-${failAt}`, version: '0', plan });
      const journal = Journal.resume(backup.journalPath);
      journal.append({ kind: 'begin', backupId: backup.id, plan });

      let seen = 0;
      const result = await apply({
        plan,
        backup,
        journal,
        onEvent: (event) => {
          if (event.kind !== 'step-start') return;
          if (seen++ === failAt) throw new Error(`주입된 실패 @${failAt}`);
        },
      });

      expect(result.failed, `단계 ${failAt} 에서 실패했어야 한다`).not.toBeNull();

      const reverted = rollback({ backupDir: backup.dir });
      expect(reverted.residue, `단계 ${failAt} 되돌리기에 잔여물`).toEqual([]);
      expect(reverted.ok).toBe(true);

      const after = ignoreBackups(snapshot(home.home));
      expect(diff(before, after), `단계 ${failAt} 이후 트리가 달라짐`).toEqual([]);
    }
  });
});
