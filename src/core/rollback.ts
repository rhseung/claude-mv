import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { readManifest, type BackupManifest } from './backup.js';
import { Journal, type JournalEntry } from './journal.js';

export type RollbackResult = {
  backupId: string;
  restored: string[];
  reverted: string[];
  removed: string[];
  residue: { path: string; why: string }[];
  ok: boolean;
};

export type RollbackInput = {
  backupDir: string;
};

export function rollback(input: RollbackInput): RollbackResult {
  const manifestPath = join(input.backupDir, 'manifest.json');
  const manifest: BackupManifest = readManifest(manifestPath);
  const journalPath = join(input.backupDir, 'journal.jsonl');
  const entries = Journal.read(journalPath);

  const result: RollbackResult = {
    backupId: manifest.backupId,
    restored: [],
    reverted: [],
    removed: [],
    residue: [],
    ok: true,
  };

  if (!manifest.sealed) {
    cleanStaging(entries, result);
    return result;
  }

  const journal = Journal.resume(journalPath);
  journal.append({ kind: 'rollback-begin' });

  for (const entry of [...entries].reverse()) {
    if (entry.kind !== 'committed') continue;

    try {
      if (entry.movedFrom) {
        if (!existsSync(entry.target)) continue;
        if (existsSync(entry.movedFrom)) {
          result.residue.push({
            path: entry.movedFrom,
            why: '되돌릴 자리에 이미 뭔가 있습니다. 덮어쓰지 않았습니다.',
          });
          result.ok = false;
          continue;
        }
        mkdirSync(dirname(entry.movedFrom), { recursive: true });
        renameSync(entry.target, entry.movedFrom);
        result.reverted.push(entry.target);
        continue;
      }

      if (entry.previousState === 'absent') {
        rmSync(entry.target, { recursive: true, force: true });
        result.removed.push(entry.target);
        continue;
      }

      const stored = manifest.entries.find((e) => e.type === 'file' && e.original === entry.target);
      if (!stored || stored.type !== 'file') {
        result.residue.push({ path: entry.target, why: '백업에 원본이 없습니다.' });
        result.ok = false;
        continue;
      }

      const source = join(input.backupDir, stored.stored);
      const actual = createHash('sha256').update(readFileSync(source)).digest('hex');
      if (actual !== stored.sha256) {
        result.residue.push({ path: entry.target, why: '백업 파일의 체크섬이 다릅니다.' });
        result.ok = false;
        continue;
      }

      const staging = `${entry.target}.claude-mv-restore`;
      copyFileSync(source, staging);
      renameSync(staging, entry.target);
      result.restored.push(entry.target);
    } catch (error) {
      result.residue.push({ path: entry.target, why: String(error) });
      result.ok = false;
    }
  }

  cleanStaging(entries, result);
  journal.append({
    kind: 'rollback-end',
    ok: result.ok,
    residue: result.residue.map((r) => r.path),
  });
  return result;
}

function cleanStaging(entries: JournalEntry[], result: RollbackResult): void {
  for (const entry of entries) {
    if (entry.kind !== 'staged') continue;
    if (!existsSync(entry.staged)) continue;
    try {
      rmSync(entry.staged, { force: true });
      result.removed.push(entry.staged);
    } catch {
      result.residue.push({ path: entry.staged, why: '임시 파일을 지우지 못했습니다.' });
    }
  }
}
