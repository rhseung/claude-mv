import { render } from 'ink';

import { App } from './App.js';
import { createStore } from './store.js';
import { PlainReporter } from '../plain/reporter.js';

import type { ApplyEvent } from '../../core/apply.js';
import type { DoctorReport } from '../../core/doctor.js';
import type { LockReport } from '../../core/lock.js';
import type { MigrationPlan } from '../../core/plan.js';
import type { ProjectDirInfo } from '../../core/scan.js';
import type { BackupSummary, Reporter } from '../reporter.js';

export function createInkReporter(): Reporter {
  const store = createStore();
  const plain = new PlainReporter();
  const instance = render(<App store={store} />, { exitOnCtrlC: false });

  return {
    plan(plan: MigrationPlan, opts: { backupId: string | null; dryRun: boolean }) {
      store.set((prev) => ({
        plan,
        backupId: opts.backupId,
        steps: plan.steps.map((step) => ({ step, status: 'pending' as const })),
        warnings: [...prev.warnings, ...plan.warnings.map(describeWarning)],
      }));
    },

    confirm(question: string) {
      return new Promise<boolean>((resolve) => {
        store.answer = (value) => {
          store.answer = null;
          store.set({ question: null });
          resolve(value);
        };
        store.set({ question });
      });
    },

    progress(event: ApplyEvent) {
      if (!('step' in event)) return;

      const status =
        event.kind === 'step-start' ? 'running' : event.kind === 'step-done' ? 'done' : 'failed';

      store.set((prev) => ({
        steps: prev.steps.map((entry) =>
          entry.step.id === event.step.id
            ? { ...entry, status, detail: 'detail' in event ? event.detail : entry.detail }
            : entry,
        ),
      }));
    },

    applied(_plan: MigrationPlan, opts: { backupId: string | null; durationMs: number }) {
      store.set({ outcome: { kind: 'ok', durationMs: opts.durationMs } });
    },

    failed(
      _plan: MigrationPlan,
      opts: { error: Error; rolledBack: boolean; backupId: string | null },
    ) {
      store.set({
        outcome: { kind: 'failed', message: opts.error.message, rolledBack: opts.rolledBack },
      });
    },

    locks(report: LockReport) {
      store.set((prev) => ({
        warnings: [
          ...prev.warnings,
          ...report.blocking.map(
            (f) =>
              `claude 세션이 이 경로를 쓰고 있습니다 (pid ${f.session.pid}, ${f.session.cwd}). 세션을 닫고 다시 실행하세요.`,
          ),
        ],
      }));
    },

    doctor: (report: DoctorReport) => plain.doctor(report),
    list: (projects: ProjectDirInfo[]) => plain.list(projects),
    info: (project: ProjectDirInfo) => plain.info(project),
    backups: (items: BackupSummary[]) => plain.backups(items),

    note(message: string) {
      if (store.state.plan) store.set((prev) => ({ notes: [...prev.notes, message] }));
      else plain.note(message);
    },

    warn(message: string) {
      if (store.state.plan) store.set((prev) => ({ warnings: [...prev.warnings, message] }));
      else plain.warn(message);
    },

    async close() {
      instance.unmount();
      await instance.waitUntilExit();
    },
  };
}

function describeWarning(warning: MigrationPlan['warnings'][number]): string {
  switch (warning.kind) {
    case 'mixed-cwd':
      return `한 세션이 여러 경로를 오갑니다. 파일은 제자리에 두고 해당 레코드만 고칩니다: ${basename(warning.file)}`;
    case 'rewritten-in-parent-dir':
      return `상위 프로젝트에 속한 ${warning.files}개 파일은 옮기지 않고 제자리에서 고칩니다.`;
    case 'mangle-collision':
      return `대상 경로가 다른 경로와 같은 디렉터리 이름을 씁니다: ${warning.other}`;
    case 'skipped-live':
      return `세션 ${warning.sessionId.slice(0, 8)} 은 실행 중이라 본체 트랜스크립트를 건드리지 않습니다.`;
    case 'nothing-to-do':
      return '옮길 상태를 찾지 못했습니다.';
  }
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}
