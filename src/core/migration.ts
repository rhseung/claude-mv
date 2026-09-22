import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { ulid } from 'ulid';

import { apply, backupRoot, type ApplyEvent } from './apply.js';
import { createBackup, type BackupHandle } from './backup.js';
import { Journal } from './journal.js';
import { buildPlan, type MigrationPlan, type MoveRequest, type PlanContext } from './plan.js';
import { rollback, type RollbackResult } from './rollback.js';

export type MigrationOutcome =
  | { status: 'planned'; plan: MigrationPlan }
  | { status: 'blocked'; plan: MigrationPlan }
  | { status: 'applied'; plan: MigrationPlan; backupId: string | null; durationMs: number }
  | {
      status: 'rolled-back';
      plan: MigrationPlan;
      backupId: string;
      error: Error;
      rollback: RollbackResult;
    }
  | { status: 'dirty'; plan: MigrationPlan; backupId: string | null; error: Error };

export type RunOptions = {
  backup: boolean;
  onEvent?: (event: ApplyEvent) => void;
};

export function newBackupId(): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return `${stamp}-${ulid().slice(-6)}`;
}

export class Migration {
  private constructor(
    readonly plan: MigrationPlan,
    private readonly toolDir: string,
  ) {}

  static prepare(request: MoveRequest, context: PlanContext & { toolDir: string }): Migration {
    return new Migration(buildPlan(request, context), context.toolDir);
  }

  get blocked(): boolean {
    return this.plan.blockers.length > 0;
  }

  get empty(): boolean {
    return this.plan.steps.length === 0;
  }

  async run(opts: RunOptions): Promise<MigrationOutcome> {
    const { plan } = this;
    if (this.blocked) return { status: 'blocked', plan };

    const root = backupRoot(this.toolDir);
    mkdirSync(root, { recursive: true });

    const backupId = newBackupId();
    const backup: BackupHandle | null = opts.backup
      ? createBackup({ root, backupId, version: 'runtime', plan })
      : null;

    const journal = Journal.resume(
      backup ? backup.journalPath : join(root, `${backupId}.journal.jsonl`),
    );
    journal.append({ kind: 'begin', backupId, plan });

    const startedAt = Date.now();
    const result = await apply({ plan, backup, journal, onEvent: opts.onEvent });

    if (!result.failed) {
      return {
        status: 'applied',
        plan,
        backupId: backup?.id ?? null,
        durationMs: Date.now() - startedAt,
      };
    }

    if (!backup) {
      return { status: 'dirty', plan, backupId: null, error: result.failed.error };
    }

    const reverted = rollback({ backupDir: backup.dir });
    return reverted.ok
      ? {
          status: 'rolled-back',
          plan,
          backupId: backup.id,
          error: result.failed.error,
          rollback: reverted,
        }
      : { status: 'dirty', plan, backupId: backup.id, error: result.failed.error };
  }
}
