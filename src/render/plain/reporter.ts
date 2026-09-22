import { createInterface } from 'node:readline/promises';

import { ago, bytes, describeStep, duration, table } from '../format.js';

import type { ApplyEvent } from '../../core/apply.js';
import type { DoctorReport } from '../../core/doctor.js';
import type { LockReport } from '../../core/lock.js';
import type { MigrationPlan } from '../../core/plan.js';
import type { ProjectDirInfo } from '../../core/scan.js';
import type { Reporter, BackupSummary } from '../reporter.js';

/**
 * 비TTY 와 --quiet 에서 쓰는 한 줄 한 사건 출력.
 *
 * 커서 제어도 스피너 프레임도 없어서 로그로 흘려보내도 읽을 수 있다.
 * ink 를 절대 import 하지 않는다 - 그게 이 파일이 따로 있는 이유다.
 */
export class PlainReporter implements Reporter {
  constructor(
    private readonly out: NodeJS.WritableStream = process.stdout,
    private readonly err: NodeJS.WritableStream = process.stderr,
  ) {}

  private write(line: string): void {
    this.out.write(`${line}\n`);
  }

  plan(plan: MigrationPlan, opts: { backupId: string | null; dryRun: boolean }): void {
    this.write(
      `plan: ${plan.steps.length} steps${opts.backupId ? `, backup ${opts.backupId}` : ''}`,
    );
    for (const step of plan.steps) {
      const d = describeStep(step);
      this.write(`  ${d.action.padEnd(8)}${d.label.padEnd(22)}${d.detail}`);
    }
    for (const warning of plan.warnings) this.warn(JSON.stringify(warning));
    if (plan.proseLeftBehind > 0) {
      this.write(`  skip    prose ${plan.proseLeftBehind}곳 (--rewrite-prose 로 포함)`);
    }
  }

  async confirm(question: string): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await rl.question(`${question} [y/N] `);
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  }

  progress(event: ApplyEvent): void {
    if (event.kind === 'step-done') {
      const d = describeStep(event.step);
      this.write(`ok      ${d.label}${event.detail ? `  ${event.detail}` : ''}`);
    } else if (event.kind === 'step-failed') {
      this.write(`failed  ${describeStep(event.step).label}  ${event.error.message}`);
    }
  }

  applied(plan: MigrationPlan, opts: { backupId: string | null; durationMs: number }): void {
    this.write(`done: ${plan.steps.length} steps in ${duration(opts.durationMs)}`);
    if (opts.backupId) this.write(`rollback: claude-mv rollback ${opts.backupId}`);
  }

  failed(
    _plan: MigrationPlan,
    opts: { error: Error; rolledBack: boolean; backupId: string | null },
  ): void {
    this.err.write(`error: ${opts.error.message}\n`);
    this.err.write(opts.rolledBack ? '전부 원래대로 돌렸습니다.\n' : '되돌리기도 실패했습니다.\n');
    if (opts.backupId) this.err.write(`backup: ${opts.backupId}\n`);
  }

  locks(report: LockReport): void {
    for (const finding of report.findings) {
      this.write(
        `lock    pid ${finding.session.pid}  ${finding.verdict}  ${finding.relation}  ${finding.session.cwd}`,
      );
    }
  }

  doctor(report: DoctorReport): void {
    this.write(`orphans: ${report.orphans.length}, healthy: ${report.healthy.length}`);
    for (const entry of report.orphans) {
      this.write(`orphan  ${entry.project.primaryCwd ?? entry.project.dirName}`);
      for (const s of entry.suggestions) {
        this.write(
          `  guess ${s.confidence.toFixed(2)}  ${s.candidate}  (${s.evidence.join(', ')})`,
        );
      }
    }
    for (const c of report.collisions) this.warn(`collision ${c.dirName}: ${c.paths.join(' , ')}`);
  }

  list(projects: ProjectDirInfo[]): void {
    for (const p of projects) {
      this.write(
        `${p.health.padEnd(16)}${bytes(p.bytes).padStart(9)}  ${String(p.transcripts.length).padStart(3)}  ${p.primaryCwd ?? p.dirName}`,
      );
    }
  }

  info(project: ProjectDirInfo): void {
    this.write(`path       ${project.primaryCwd ?? '(판정 불가)'}`);
    this.write(`dir        ${project.dirPath}`);
    this.write(`health     ${project.health}`);
    this.write(`size       ${bytes(project.bytes)}`);
    for (const t of project.transcripts) {
      this.write(`  ${t.kind.padEnd(9)}${t.sessionId}  ${t.lines} 줄  ${bytes(t.bytes)}`);
    }
    for (const [path, lines] of [...project.cwdCensus].sort((a, b) => b[1] - a[1])) {
      this.write(`  cwd  ${String(lines).padStart(5)}  ${path}`);
    }
  }

  backups(items: BackupSummary[]): void {
    if (items.length === 0) {
      this.write('백업이 없습니다.');
      return;
    }
    for (const line of table(
      items.map((b) => [
        b.id,
        ago(b.createdAt),
        b.src,
        '->',
        b.dst,
        b.restorable ? '' : '(대상 없음)',
      ]),
    )) {
      this.write(line);
    }
  }

  note(message: string): void {
    this.write(message);
  }

  warn(message: string): void {
    this.err.write(`warn: ${message}\n`);
  }

  async close(): Promise<void> {}
}
