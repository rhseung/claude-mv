import type { ApplyEvent } from '../core/apply.js';
import type { DoctorReport } from '../core/doctor.js';
import type { LockReport } from '../core/lock.js';
import type { MigrationPlan } from '../core/plan.js';
import type { ProjectDirInfo } from '../core/scan.js';

export type BackupSummary = {
  id: string;
  createdAt: number;
  src: string;
  dst: string;
  bytes: number;
  restorable: boolean;
};

export type Reporter = {
  plan(plan: MigrationPlan, opts: { backupId: string | null; dryRun: boolean }): void;
  confirm(question: string): Promise<boolean>;
  progress(event: ApplyEvent): void;
  applied(plan: MigrationPlan, opts: { backupId: string | null; durationMs: number }): void;
  failed(
    plan: MigrationPlan,
    opts: { error: Error; rolledBack: boolean; backupId: string | null },
  ): void;
  locks(report: LockReport): void;
  doctor(report: DoctorReport): void;
  list(projects: ProjectDirInfo[]): void;
  info(project: ProjectDirInfo): void;
  backups(items: BackupSummary[]): void;
  note(message: string): void;
  warn(message: string): void;
  close(): Promise<void>;
};

export type RenderMode = 'ink' | 'plain' | 'json';

export function resolveRenderMode(opts: {
  json: boolean;
  quiet: boolean;
  isTTY: boolean;
  ci: boolean;
  term: string | undefined;
}): RenderMode {
  if (opts.json) return 'json';
  if (!opts.isTTY) return 'plain';
  if (opts.ci) return 'plain';
  if (opts.term === 'dumb') return 'plain';
  if (opts.quiet) return 'plain';
  return 'ink';
}
