import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import fsExtra from 'fs-extra';
import writeFileAtomic from 'write-file-atomic';

import { seal, type BackupHandle } from './backup.js';
import { applyEdits, planConfigEdits } from './config-edit.js';
import { type Journal } from './journal.js';
import { commitStaged, rewriteJsonl, rewriteTranscript } from './jsonl.js';
import { reparent } from './paths.js';

import type { MigrationPlan, PlanStep } from './plan.js';

export type ApplyEvent =
  | { kind: 'phase'; phase: string }
  | { kind: 'step-start'; step: PlanStep }
  | { kind: 'step-done'; step: PlanStep; detail?: string }
  | { kind: 'step-failed'; step: PlanStep; error: Error };

export type ApplyOptions = {
  plan: MigrationPlan;
  backup: BackupHandle | null;
  journal: Journal;
  onEvent?: (event: ApplyEvent) => void;
  /** 계산만 하고 아무것도 쓰지 않는다. 실제 실행과 같은 코드 경로를 탄다. */
  dryRun?: boolean;
};

export type ApplyResult = {
  completed: PlanStep[];
  failed: { step: PlanStep; error: Error } | null;
};

type Staged = { step: PlanStep; staged: string; target: string; detail?: string };

/**
 * 계획을 실행한다.
 *
 * 단계 순서가 이 파일의 핵심이다. 위치가 여섯 군데라 전체를 한 번에 원자적으로 만들 수는
 * 없으므로, **느리고 되돌릴 수 있는 작업을 전부 앞으로 몰고 커밋 꼬리를 짧게** 만든다.
 * 스테이징 단계에서 실패하면 사용자 눈에 보이는 건 아무것도 바뀌지 않았고 임시 파일만 지우면 된다.
 *
 * 커밋 순서는 실패했을 때 피해가 작은 것부터다. `~/.claude.json` 이 가장 소중하므로
 * 노출 시간이 가장 짧고, 실제 디렉터리 이동은 같은 파일시스템이면 rename 한 번이라
 * 가장 좋은 커밋 지점이라 맨 뒤에 둔다.
 */
export async function apply(opts: ApplyOptions): Promise<ApplyResult> {
  const { plan, journal, onEvent } = opts;
  const emit = (event: ApplyEvent): void => onEvent?.(event);
  const completed: PlanStep[] = [];

  const commitOrder: PlanStep['kind'][] = [
    'move-cache-dir',
    'rewrite-transcript',
    'rewrite-plan',
    'move-project-dir',
    'rewrite-history',
    'edit-config',
    'move-directory',
    'repair-worktrees',
  ];
  const ordered = [...plan.steps].sort(
    (a, b) => commitOrder.indexOf(a.kind) - commitOrder.indexOf(b.kind),
  );

  // --- PHASE 1: 백업 ---
  emit({ kind: 'phase', phase: 'backup' });
  if (opts.backup && !opts.dryRun) {
    journal.append({ kind: 'backup-sealed' });
    seal(opts.backup);
  }

  // --- PHASE 2: 스테이징 ---
  emit({ kind: 'phase', phase: 'stage' });
  const staged: Staged[] = [];

  try {
    for (const step of ordered) {
      if (!needsStaging(step)) continue;
      emit({ kind: 'step-start', step });

      const result = await stage(step, plan, opts.dryRun ?? false);
      if (result) {
        staged.push(result);
        if (!opts.dryRun) {
          journal.append({
            kind: 'staged',
            stepId: step.id,
            staged: result.staged,
            target: result.target,
          });
        }
      }
      emit({ kind: 'step-done', step, detail: result?.detail });
    }
  } catch (error) {
    for (const s of staged) rmSync(s.staged, { force: true });
    emit({ kind: 'step-failed', step: ordered[0]!, error: error as Error });
    return { completed, failed: { step: ordered[0]!, error: error as Error } };
  }

  if (opts.dryRun) return { completed: ordered, failed: null };

  // --- 커밋 장벽 ---
  journal.append({ kind: 'commit-barrier' });

  // --- PHASE 3: 커밋 ---
  emit({ kind: 'phase', phase: 'commit' });
  for (const step of ordered) {
    emit({ kind: 'step-start', step });
    journal.append({ kind: 'step-begin', stepId: step.id, step });

    try {
      const entry = staged.find((s) => s.step.id === step.id);
      if (entry) {
        await commitStaged(entry.staged, entry.target);
        journal.append({
          kind: 'committed',
          stepId: step.id,
          target: entry.target,
          previousState: 'existed',
        });
      } else {
        commitMove(step, journal);
      }
      completed.push(step);
      emit({ kind: 'step-done', step });
    } catch (error) {
      journal.append({ kind: 'step-failed', stepId: step.id, error: String(error) });
      emit({ kind: 'step-failed', step, error: error as Error });
      return { completed, failed: { step, error: error as Error } };
    }
  }

  journal.append({ kind: 'end', ok: true });
  return { completed, failed: null };
}

function needsStaging(step: PlanStep): boolean {
  return (
    step.kind === 'rewrite-transcript' ||
    step.kind === 'rewrite-history' ||
    step.kind === 'edit-config' ||
    step.kind === 'rewrite-plan'
  );
}

async function stage(step: PlanStep, plan: MigrationPlan, dryRun: boolean): Promise<Staged | null> {
  const { src, dst, policy, platform, rewriteProse } = plan.request;
  const map = (value: string): string | undefined => reparent(value, src, dst, policy, platform);

  switch (step.kind) {
    case 'rewrite-transcript': {
      if (dryRun) return null;
      const result = await rewriteTranscript(step.file, map, {
        includeProse: rewriteProse,
        stagingSuffix: 'stage',
      });
      if (!result.staged) return null;
      return {
        step,
        staged: result.staged,
        target: step.file,
        detail: `${result.linesChanged}/${result.linesTotal} 줄`,
      };
    }

    case 'rewrite-history': {
      if (dryRun) return null;
      const result = await rewriteJsonl(
        step.file,
        (record) => {
          if (typeof record !== 'object' || record === null) return false;
          const holder = record as { project?: unknown };
          if (typeof holder.project !== 'string') return false;
          const next = map(holder.project);
          if (next === undefined) return false;
          holder.project = next;
          return true;
        },
        { stagingSuffix: 'stage' },
      );
      if (!result.staged) return null;
      return {
        step,
        staged: result.staged,
        target: step.file,
        detail: `${result.linesChanged} 줄`,
      };
    }

    case 'edit-config': {
      if (dryRun) return null;
      const text = readFileSync(step.file, 'utf8');
      const edits = planConfigEdits(text, { src, dst, policy, platform });
      if (edits.length === 0) return null;

      // 통째로 다시 쓰지 않는다. 바뀌는 건 키 문자열이 놓인 바이트 구간뿐이다.
      const staging = `${step.file}.claude-mv-stage`;
      await writeFileAtomic(staging, applyEdits(text, edits));
      return { step, staged: staging, target: step.file, detail: `${edits.length}곳` };
    }

    case 'rewrite-plan': {
      if (dryRun) return null;
      const text = readFileSync(step.file, 'utf8');
      // 플랜은 마크다운이라 구조 필드가 없다. 문서 전체에서 경로를 바꾼다 -
      // 앞으로 따라야 할 지시서이므로 낡은 경로가 남으면 그대로 틀린 일을 하게 된다.
      const next = text.split(src).join(dst);
      if (next === text) return null;

      const staging = `${step.file}.claude-mv-stage`;
      await writeFileAtomic(staging, next);
      return { step, staged: staging, target: step.file, detail: '경로 치환' };
    }

    default:
      return null;
  }
}

function commitMove(step: PlanStep, journal: Journal): void {
  switch (step.kind) {
    case 'move-project-dir':
    case 'move-cache-dir':
    case 'move-directory': {
      if (!existsSync(step.from)) return;
      mkdirSync(dirname(step.to), { recursive: true });
      moveDirectory(step.from, step.to);
      journal.append({
        kind: 'committed',
        stepId: step.id,
        target: step.to,
        previousState: 'absent',
        movedFrom: step.from,
      });
      return;
    }
    default:
      return;
  }
}

/**
 * 같은 파일시스템이면 rename 한 번으로 끝나고 원자적이다.
 * 다른 파일시스템이면 복사 후 삭제로 떨어지는데, 이 경우만 중간 상태가 생긴다.
 */
function moveDirectory(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    fsExtra.moveSync(from, to, { overwrite: false });
  }
}

export function sameDevice(a: string, b: string): boolean {
  try {
    return statSync(a).dev === statSync(dirname(b)).dev;
  } catch {
    return false;
  }
}

export function backupRoot(toolDir: string): string {
  return join(toolDir, 'backups');
}
