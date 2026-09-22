import { describe, expect, it } from 'vitest';

import { JsonReporter, SCHEMA_VERSION } from '../src/render/json/reporter.js';

import type { MigrationPlan } from '../src/core/plan.js';

class Sink {
  lines: string[] = [];
  write(chunk: string) {
    this.lines.push(chunk);
    return true;
  }
  get parsed(): unknown[] {
    return this.lines.map((l) => JSON.parse(l));
  }
}

const plan = {
  request: {
    src: '/a/old',
    dst: '/a/new',
    stateOnly: false,
    rewriteProse: false,
    policy: 'sensitive',
    platform: 'linux',
  },
  steps: [{ kind: 'move-directory', id: 'working-tree', from: '/a/old', to: '/a/new' }],
  blockers: [],
  warnings: [],
  proseLeftBehind: 3,
} as unknown as MigrationPlan;

describe('JSON 출력', () => {
  it('진행은 stderr, 결과 객체 하나는 stdout', async () => {
    const out = new Sink();
    const err = new Sink();
    const reporter = new JsonReporter(out as never, err as never, '1.2.3');

    reporter.plan(plan, { backupId: 'b1', dryRun: true });
    reporter.progress({ kind: 'step-start', step: plan.steps[0]! });
    reporter.note('작업 중');
    await reporter.close();

    expect(out.lines).toHaveLength(1);
    expect(err.parsed.map((e) => (e as { kind: string }).kind)).toEqual(['progress', 'note']);
  });

  it('봉투에 tool, version, schema 가 들어간다', async () => {
    const out = new Sink();
    const reporter = new JsonReporter(out as never, new Sink() as never, '1.2.3');
    reporter.plan(plan, { backupId: null, dryRun: true });
    await reporter.close();

    expect(JSON.parse(out.lines[0]!)).toMatchObject({
      tool: 'claude-mv',
      version: '1.2.3',
      schema: SCHEMA_VERSION,
      kind: 'plan',
      src: '/a/old',
      dst: '/a/new',
      proseLeftBehind: 3,
    });
  });

  it('--json 에서는 물어볼 수 없으므로 확인은 항상 거절이다', async () => {
    const reporter = new JsonReporter(new Sink() as never, new Sink() as never);
    expect(await reporter.confirm()).toBe(false);
  });

  it('결과에 ok 와 rollback 상태가 들어간다', async () => {
    const out = new Sink();
    const reporter = new JsonReporter(out as never, new Sink() as never);
    reporter.failed(plan, { error: new Error('터짐'), rolledBack: true, backupId: 'b1' });
    await reporter.close();

    expect(JSON.parse(out.lines[0]!)).toMatchObject({
      kind: 'result',
      ok: false,
      error: '터짐',
      rollback: { attempted: true, ok: true },
    });
  });
});
