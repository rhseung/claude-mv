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
      previousState: 'existed' | 'absent';
      movedFrom?: string;
    }
  | { kind: 'step-failed'; stepId: string; error: string }
  | { kind: 'commit-barrier' }
  | { kind: 'end'; ok: boolean }
  | { kind: 'rollback-begin' }
  | { kind: 'rollback-end'; ok: boolean; residue: string[] };

export type JournalEntry = JournalPayload & { seq: number; t: number };

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
        break;
      }
    }
    return entries;
  }

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
