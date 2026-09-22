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

/**
 * 출력 방식 세 가지(ink / plain / json)가 공유하는 계약.
 *
 * commands/ 는 이 인터페이스만 알고 React 를 모른다. 그래야 SessionStart 훅과
 * --json 경로가 ink 를 끌어오지 않는다. eslint 규칙이 이 경계를 강제한다.
 */
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
  /** ink 를 쓴 경우 렌더러를 정리한다. */
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
  // NO_COLOR 는 여기서 보지 않는다. 색을 끄고 싶은 것이지 진행 표시를 끄려는 게 아니다.
  return 'ink';
}
