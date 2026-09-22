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
  /** 안전하게 되돌리지 못해 사람이 봐야 하는 것들. */
  residue: { path: string; why: string }[];
  ok: boolean;
};

export type RollbackInput = {
  backupDir: string;
};

/**
 * 저널을 역순으로 재생해서 원래대로 돌린다.
 *
 * rollback 자체도 저널에 기록되고 멱등하게 만들어져 있다. 되돌리는 도중에 죽어도
 * 다시 실행하면 이어서 끝낼 수 있어야 하기 때문이다.
 */
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

  // 봉인되지 않은 백업은 커밋 장벽을 넘기 전에 죽었다는 뜻이다. 그러면 사용자 눈에
  // 보이는 변경은 없고, 남은 임시 파일만 치우면 된다.
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
        // 디렉터리 이동은 역방향 rename 한 번이면 끝난다.
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

      // 백업에서 바로 덮어쓰지 않고 임시 파일을 거쳐 rename 한다. 되돌리는 도중에
      // 죽어도 대상 파일이 반쯤 쓰인 상태로 남지 않는다.
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
