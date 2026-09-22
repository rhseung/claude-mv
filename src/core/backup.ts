import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

import type { MigrationPlan } from './plan.js';

export type BackupEntry =
  | {
      type: 'file';
      original: string;
      stored: string;
      sha256: string;
      size: number;
      mode: number;
    }
  /** 디렉터리 rename 은 역방향 rename 으로 되돌린다. 내용을 복사하지 않는다. */
  | { type: 'dir-move'; from: string; to: string }
  /** 계획이 새로 만들 경로. 되돌릴 때는 복원이 아니라 삭제다. */
  | { type: 'absent'; original: string };

export type BackupManifest = {
  version: 1;
  backupId: string;
  createdAt: number;
  tool: { name: 'claude-mv'; version: string };
  src: string;
  dst: string;
  entries: BackupEntry[];
  /**
   * 모든 항목이 디스크에 닿은 뒤에 마지막으로 쓴다.
   * 이 값이 없으면 커밋 전에 죽었다는 뜻이고, 그러면 되돌릴 것도 없다.
   */
  sealed: boolean;
};

export type BackupHandle = {
  id: string;
  dir: string;
  manifestPath: string;
  journalPath: string;
  entries: BackupEntry[];
};

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * 백업 디렉터리로 파일 하나를 들인다.
 *
 * 같은 파일시스템이면 복사 대신 하드링크를 건다. 재작성이 항상
 * "새 파일을 쓰고 rename" 이라 원본 inode 는 그대로 남고, 링크는 그 inode 를 붙잡는다.
 * 덕분에 수 GB 짜리 상태도 백업 비용이 0 에 가깝다. 파일시스템이 다르거나 링크 수
 * 한계에 걸리면 복사로 떨어진다.
 */
function stash(original: string, storedAbs: string): void {
  mkdirSync(dirname(storedAbs), { recursive: true });
  try {
    linkSync(original, storedAbs);
  } catch {
    copyFileSync(original, storedAbs);
  }
}

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, out);
    else out.push(full);
  }
  return out;
}

export type BackupInput = {
  root: string;
  backupId: string;
  version: string;
  plan: MigrationPlan;
};

export function createBackup(input: BackupInput): BackupHandle {
  const dir = join(input.root, input.backupId);
  const filesDir = join(dir, 'files');
  mkdirSync(filesDir, { recursive: true });

  const entries: BackupEntry[] = [];
  const seen = new Set<string>();

  const addFile = (path: string): void => {
    if (seen.has(path) || !existsSync(path)) return;
    seen.add(path);
    const stats = statSync(path);
    // 원본의 절대 경로를 그대로 디렉터리 구조로 재현해서, 되돌릴 때 어디로 돌아가는지
    // 매니페스트를 읽지 않고도 눈으로 확인할 수 있게 한다.
    const stored = join('files', path.replace(/^[/\\]/, '').replace(/:/g, '_'));
    stash(path, join(dir, stored));
    entries.push({
      type: 'file',
      original: path,
      stored,
      sha256: sha256(path),
      size: stats.size,
      mode: stats.mode,
    });
  };

  for (const step of input.plan.steps) {
    switch (step.kind) {
      case 'rewrite-transcript':
      case 'rewrite-plan':
        addFile(step.file);
        break;
      case 'edit-config':
      case 'rewrite-history':
        addFile(step.file);
        break;
      case 'move-project-dir':
        // 디렉터리 rename 은 되돌리기가 역방향 rename 한 번이라 내용을 복사할 필요가 없다.
        // 다만 안에 든 파일은 재작성 대상이기도 해서 개별로 이미 들어가 있다.
        entries.push({ type: 'dir-move', from: step.from, to: step.to });
        entries.push({ type: 'absent', original: step.to });
        break;
      case 'move-cache-dir':
        entries.push({ type: 'dir-move', from: step.from, to: step.to });
        entries.push({ type: 'absent', original: step.to });
        break;
      case 'move-directory':
        entries.push({ type: 'dir-move', from: step.from, to: step.to });
        entries.push({ type: 'absent', original: step.to });
        break;
      case 'repair-worktrees':
        for (const file of collectFiles(join(step.repoRoot, '.git', 'worktrees')).filter((f) =>
          f.endsWith('gitdir'),
        )) {
          addFile(file);
        }
        break;
    }
  }

  const manifest: BackupManifest = {
    version: 1,
    backupId: input.backupId,
    createdAt: Date.now(),
    tool: { name: 'claude-mv', version: input.version },
    src: input.plan.request.src,
    dst: input.plan.request.dst,
    entries,
    sealed: false,
  };

  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    id: input.backupId,
    dir,
    manifestPath,
    journalPath: join(dir, 'journal.jsonl'),
    entries,
  };
}

/** 모든 항목이 자리를 잡은 뒤에만 부른다. 이 뒤부터 rollback 이 의미를 가진다. */
export function seal(handle: BackupHandle): void {
  const manifest = readManifest(handle.manifestPath);
  manifest.sealed = true;
  writeFileSync(handle.manifestPath, JSON.stringify(manifest, null, 2));
}

export function readManifest(path: string): BackupManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as BackupManifest;
}

export function listBackups(root: string): BackupManifest[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }

  const out: BackupManifest[] = [];
  for (const name of names) {
    try {
      out.push(readManifest(join(root, name, 'manifest.json')));
    } catch {
      // 중간에 죽어 매니페스트가 없는 디렉터리는 건너뛴다.
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function storedPath(handle: { dir: string }, entry: BackupEntry & { type: 'file' }): string {
  return join(handle.dir, entry.stored);
}

export function relativeToBackup(dir: string, path: string): string {
  return relative(dir, path);
}
