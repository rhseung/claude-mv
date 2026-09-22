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
  | { type: 'dir-move'; from: string; to: string }
  | { type: 'absent'; original: string };

export type BackupManifest = {
  version: 1;
  backupId: string;
  createdAt: number;
  tool: { name: 'claude-mv'; version: string };
  src: string;
  dst: string;
  entries: BackupEntry[];
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
    } catch {}
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function storedPath(handle: { dir: string }, entry: BackupEntry & { type: 'file' }): string {
  return join(handle.dir, entry.stored);
}

export function relativeToBackup(dir: string, path: string): string {
  return relative(dir, path);
}
