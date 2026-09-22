import type { ApplyEvent } from '../../core/apply.js';
import type { DoctorReport } from '../../core/doctor.js';
import type { LockReport } from '../../core/lock.js';
import type { MigrationPlan } from '../../core/plan.js';
import type { ProjectDirInfo } from '../../core/scan.js';
import type { BackupSummary, Reporter } from '../reporter.js';

export const SCHEMA_VERSION = 1;

export class JsonReporter implements Reporter {
  private result: Record<string, unknown> | null = null;

  constructor(
    private readonly out: NodeJS.WritableStream = process.stdout,
    private readonly err: NodeJS.WritableStream = process.stderr,
    private readonly version = '0.0.0',
  ) {}

  private envelope(kind: string, body: Record<string, unknown>): Record<string, unknown> {
    return { tool: 'claude-mv', version: this.version, schema: SCHEMA_VERSION, kind, ...body };
  }

  private event(body: Record<string, unknown>): void {
    this.err.write(`${JSON.stringify(body)}\n`);
  }

  plan(plan: MigrationPlan, opts: { backupId: string | null; dryRun: boolean }): void {
    this.result = this.envelope(opts.dryRun ? 'plan' : 'pending', {
      src: plan.request.src,
      dst: plan.request.dst,
      options: {
        stateOnly: plan.request.stateOnly,
        rewriteProse: plan.request.rewriteProse,
      },
      steps: plan.steps,
      blockers: plan.blockers,
      warnings: plan.warnings,
      proseLeftBehind: plan.proseLeftBehind,
      backup: opts.backupId ? { id: opts.backupId } : null,
    });
  }

  async confirm(): Promise<boolean> {
    return false;
  }

  progress(event: ApplyEvent): void {
    this.event({
      kind: 'progress',
      event: event.kind,
      step: 'step' in event ? event.step.id : undefined,
      phase: 'phase' in event ? event.phase : undefined,
      detail: 'detail' in event ? event.detail : undefined,
    });
  }

  applied(plan: MigrationPlan, opts: { backupId: string | null; durationMs: number }): void {
    this.result = this.envelope('result', {
      src: plan.request.src,
      dst: plan.request.dst,
      steps: plan.steps.map((s) => ({ ...s, status: 'done' })),
      backup: opts.backupId ? { id: opts.backupId } : null,
      durationMs: opts.durationMs,
      ok: true,
    });
  }

  failed(
    plan: MigrationPlan,
    opts: { error: Error; rolledBack: boolean; backupId: string | null },
  ): void {
    this.result = this.envelope('result', {
      src: plan.request.src,
      dst: plan.request.dst,
      ok: false,
      error: opts.error.message,
      rollback: { attempted: true, ok: opts.rolledBack },
      backup: opts.backupId ? { id: opts.backupId } : null,
    });
  }

  locks(report: LockReport): void {
    this.event({ kind: 'locks', findings: report.findings });
  }

  doctor(report: DoctorReport): void {
    this.result = this.envelope('doctor', {
      orphans: report.orphans.map((entry) => ({
        encoded: entry.project.dirName,
        path: entry.project.primaryCwd,
        pathSource: entry.project.primaryCwd ? 'transcript' : 'unknown',
        health: entry.project.health,
        sizeBytes: entry.project.bytes,
        lastActivity: entry.project.lastActivityMs,
        transcripts: entry.project.transcripts.length,
        alsoIn: entry.alsoIn,
        suggestions: entry.suggestions,
      })),
      healthy: report.healthy.map((p) => ({ path: p.primaryCwd, encoded: p.dirName })),
      collisions: report.collisions,
    });
  }

  list(projects: ProjectDirInfo[]): void {
    this.result = this.envelope('list', {
      projects: projects.map((p) => ({
        path: p.primaryCwd,
        encoded: p.dirName,
        health: p.health,
        sizeBytes: p.bytes,
        transcripts: p.transcripts.length,
        lastActivity: p.lastActivityMs,
      })),
    });
  }

  info(project: ProjectDirInfo): void {
    this.result = this.envelope('info', {
      path: project.primaryCwd,
      encoded: project.dirName,
      dir: project.dirPath,
      health: project.health,
      sizeBytes: project.bytes,
      transcripts: project.transcripts.map((t) => ({
        kind: t.kind,
        sessionId: t.sessionId,
        agentId: t.agentId,
        lines: t.lines,
        bytes: t.bytes,
        malformed: t.malformed.length,
      })),
      cwdCensus: Object.fromEntries(project.cwdCensus),
    });
  }

  backups(items: BackupSummary[]): void {
    this.result = this.envelope('backups', { backups: items });
  }

  note(message: string): void {
    this.event({ kind: 'note', message });
  }

  warn(message: string): void {
    this.event({ kind: 'warn', message });
  }

  async close(): Promise<void> {
    if (this.result) this.out.write(`${JSON.stringify(this.result, null, 2)}\n`);
  }
}
