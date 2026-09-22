import { appendFileSync, closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';

import type { MigrationPlan, PlanStep } from './plan.js';

export type JournalPayload =
  | { kind: 'begin'; backupId: string; plan: MigrationPlan }
  | { kind: 'backup-sealed' }
  | { kind: 'step-begin'; stepId: string; step: PlanStep }
  | { kind: 'staged'; stepId: string; staged: string; target: string }
  | {
      kind: 'committed';
      stepId: string;
      target: string;
      /** 되돌릴 때 복원할지 지워야 할지를 가른다. */
      previousState: 'existed' | 'absent';
      /** 디렉터리 이동이면 역방향 rename 으로 되돌린다. */
      movedFrom?: string;
    }
  | { kind: 'step-failed'; stepId: string; error: string }
  | { kind: 'commit-barrier' }
  | { kind: 'end'; ok: boolean }
  | { kind: 'rollback-begin' }
  | { kind: 'rollback-end'; ok: boolean; residue: string[] };

/** 저장될 때 seq 와 시각이 붙는다. */
export type JournalEntry = JournalPayload & { seq: number; t: number };

/**
 * 선행 기록 로그.
 *
 * 규율이 하나 있다: **한 줄을 쓰고 fsync 한 다음에야 그 효과를 실행한다.** 순서가 뒤집히면
 * 크래시했을 때 "일어났는데 기록에 없는" 변경이 생기고, 그건 되돌릴 수 없다.
 */
export class Journal {
  private seq = 0;

  constructor(private readonly path: string) {}

  append(entry: JournalPayload): void {
    const line = `${JSON.stringify({ seq: this.seq++, t: Date.now(), ...entry })}\n`;
    const fd = openSync(this.path, 'a');
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  static read(path: string): JournalEntry[] {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return [];
    }

    const entries: JournalEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line) as JournalEntry);
      } catch {
        // 크래시로 마지막 줄이 잘렸을 수 있다. 거기까지만 신뢰한다.
        break;
      }
    }
    return entries;
  }

  /** 이어 쓰기 위해 기존 저널의 다음 seq 로 맞춘다. */
  static resume(path: string): Journal {
    const journal = new Journal(path);
    const entries = Journal.read(path);
    journal.seq = (entries.at(-1)?.seq ?? -1) + 1;
    return journal;
  }
}

export function appendRaw(path: string, text: string): void {
  appendFileSync(path, text);
}
