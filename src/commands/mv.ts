import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { ulid } from 'ulid';

import { ExitCode, CliError, type ExitCodeName } from '../cli/exit.js';
import { apply, backupRoot } from '../core/apply.js';
import { createBackup } from '../core/backup.js';
import { Journal } from '../core/journal.js';
import { checkLocks } from '../core/lock.js';
import { Migration } from '../core/migration.js';
import { normalizePath, pathEquals } from '../core/paths.js';
import { rollback } from '../core/rollback.js';

import type { MigrationPlan, MoveRequest } from '../core/plan.js';
import type { Reporter } from '../render/reporter.js';
import type { AppContext } from '../shared/context.js';

export type MoveOptions = {
  src: string;
  dst: string;
  stateOnly: boolean;
  rewriteProse: boolean;
  dryRun: boolean;
  yes: boolean;
  force: boolean;
  noBackup: boolean;
  allowAncestors: boolean;
  skipLive: boolean;
  home: string;
  version: string;
};

export async function runMove(
  ctx: AppContext,
  reporter: Reporter,
  opts: MoveOptions,
): Promise<ExitCodeName> {
  const norm = (value: string, realpath = true): string =>
    normalizePath(value, { platform: ctx.platform, home: opts.home, realpath });

  const src = pickKnown(ctx, [norm(opts.src), norm(opts.src, false)]);
  const dst = norm(opts.dst, false);

  if (src === dst) throw new CliError('src 와 dst 가 같습니다.', 'usage');

  const request: MoveRequest = {
    src,
    dst,
    stateOnly: opts.stateOnly || (!ctx.exists(src) && ctx.exists(dst)),
    rewriteProse: opts.rewriteProse,
    policy: ctx.policy,
    platform: ctx.platform,
  };

  const locks = await checkLocks(ctx.index.sessions, {
    src,
    policy: ctx.policy,
    platform: ctx.platform,
    probe: ctx.probe,
    allowAncestors: opts.allowAncestors,
  });

  const migration = Migration.prepare(request, {
    index: ctx.index,
    configPath: ctx.env.configPath,
    historyPath: ctx.env.historyPath,
    projectsDir: ctx.env.projectsDir,
    plansDir: ctx.env.plansDir,
    cacheRoot: ctx.env.cacheRoot,
    toolDir: ctx.env.toolDir,
    fileExists: ctx.exists,
    srcExists: ctx.exists(src),
    dstExists: ctx.exists(dst),
    locks: opts.force ? { findings: locks.findings, blocking: [] } : locks,
    skipLiveTranscripts: opts.skipLive,
  });
  const plan = migration.plan;

  const informational = locks.findings.filter((finding) => !locks.blocking.includes(finding));
  if (informational.length > 0) reporter.locks({ findings: informational, blocking: [] });

  if (plan.warnings.some((w) => w.kind === 'nothing-to-do')) {
    reporter.plan(plan, { backupId: null, dryRun: true });
    reporter.note('옮길 상태를 찾지 못했습니다.');
    return 'nothingToDo';
  }

  if (opts.dryRun || plan.blockers.length > 0) {
    reporter.plan(plan, { backupId: null, dryRun: true });
    for (const blocker of plan.blockers) reporter.warn(describeBlocker(blocker));
    if (plan.blockers.length > 0) return blockerExit(plan);
    return 'planned';
  }

  const backupId = `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${ulid().slice(-6)}`;
  reporter.plan(plan, { backupId: opts.noBackup ? null : backupId, dryRun: false });

  if (
    !opts.yes &&
    !(await reporter.confirm(`${plan.steps.length}개 항목을 옮깁니다. 진행할까요?`))
  ) {
    reporter.note('취소했습니다.');
    return 'ok';
  }

  const root = backupRoot(ctx.env.toolDir);
  mkdirSync(root, { recursive: true });

  const backup = opts.noBackup
    ? null
    : createBackup({ root, backupId, version: opts.version, plan });
  const journal = Journal.resume(
    backup ? backup.journalPath : join(root, `${backupId}.journal.jsonl`),
  );
  journal.append({ kind: 'begin', backupId, plan });

  const startedAt = Date.now();
  const result = await apply({
    plan,
    backup,
    journal,
    onEvent: (event) => reporter.progress(event),
  });

  if (!result.failed) {
    reporter.applied(plan, {
      backupId: backup?.id ?? null,
      durationMs: Date.now() - startedAt,
    });
    return 'ok';
  }

  if (!backup) {
    reporter.failed(plan, { error: result.failed.error, rolledBack: false, backupId: null });
    return 'failedDirty';
  }

  const reverted = rollback({ backupDir: backup.dir });
  reporter.failed(plan, {
    error: result.failed.error,
    rolledBack: reverted.ok,
    backupId: backup.id,
  });
  for (const residue of reverted.residue) reporter.warn(`${residue.path}: ${residue.why}`);

  return reverted.ok ? 'failedRolledBack' : 'failedDirty';
}

function pickKnown(ctx: AppContext, candidates: string[]): string {
  for (const candidate of candidates) {
    const known =
      ctx.index.projects.some(
        (p) =>
          (p.primaryCwd && pathEquals(p.primaryCwd, candidate, ctx.policy)) ||
          [...p.cwdCensus.keys()].some((c) => pathEquals(c, candidate, ctx.policy)),
      ) || ctx.index.configProjectKeys.some((k) => pathEquals(k, candidate, ctx.policy));
    if (known) return candidate;
  }
  return candidates[0]!;
}

function blockerExit(plan: MigrationPlan): ExitCodeName {
  if (plan.blockers.some((b) => b.kind === 'locked')) return 'locked';
  if (plan.blockers.some((b) => b.kind === 'src-missing' || b.kind === 'dst-inside-src')) {
    return 'precondition';
  }
  return 'conflict';
}

function describeBlocker(blocker: MigrationPlan['blockers'][number]): string {
  switch (blocker.kind) {
    case 'locked':
      return `claude 세션이 이 경로를 쓰고 있습니다 (pid ${blocker.sessions.map((s) => s.pid).join(', ')}). 세션을 닫고 다시 실행하세요.`;
    case 'dst-project-dir-exists':
      return `대상 경로의 project 디렉터리가 이미 있습니다: ${blocker.dirName}`;
    case 'dst-config-key-exists':
      return `claude.json 에 대상 경로 키가 이미 있습니다: ${blocker.key}`;
    case 'src-missing':
      return '원본 디렉터리가 없습니다. 이미 옮겼다면 --state-only 를 쓰세요.';
    case 'dst-inside-src':
      return '대상 경로가 원본 안에 있습니다.';
  }
}

export { ExitCode };
