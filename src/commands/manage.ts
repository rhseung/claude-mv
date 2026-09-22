import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

import { ulid } from 'ulid';
import writeFileAtomic from 'write-file-atomic';

import { findProject } from './query.js';
import { CliError, type ExitCodeName } from '../cli/exit.js';
import { backupRoot } from '../core/apply.js';
import { createBackup, listBackups, seal } from '../core/backup.js';
import { applyEdits, planConfigRemoval } from '../core/config-edit.js';
import { Journal } from '../core/journal.js';
import { rollback } from '../core/rollback.js';

import type { BackupSummary, Reporter } from '../render/reporter.js';
import type { AppContext } from '../shared/context.js';

function newBackupId(): string {
  return `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${ulid().slice(-6)}`;
}

function dirBytes(dir: string): number {
  let total = 0;
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += statSync(full).size;
    }
  };
  try {
    walk(dir);
  } catch {
    return total;
  }
  return total;
}

export function runBackups(ctx: AppContext, reporter: Reporter): ExitCodeName {
  const root = backupRoot(ctx.env.toolDir);
  const items: BackupSummary[] = listBackups(root).map((manifest) => ({
    id: manifest.backupId,
    createdAt: manifest.createdAt,
    src: manifest.src,
    dst: manifest.dst,
    bytes: dirBytes(join(root, manifest.backupId)),
    restorable: manifest.sealed && !existsSync(manifest.src),
  }));

  reporter.backups(items);
  return 'ok';
}

export function runRollback(
  ctx: AppContext,
  reporter: Reporter,
  opts: { id: string },
): ExitCodeName {
  const root = backupRoot(ctx.env.toolDir);
  const all = listBackups(root);
  const manifest = opts.id === 'last' ? all[0] : all.find((m) => m.backupId === opts.id);
  if (!manifest) throw new CliError(`그런 백업이 없습니다: ${opts.id}`, 'usage');

  const result = rollback({ backupDir: join(root, manifest.backupId) });
  for (const path of result.reverted) reporter.note(`되돌림  ${path}`);
  for (const path of result.restored) reporter.note(`복원    ${path}`);
  for (const residue of result.residue) reporter.warn(`${residue.path}: ${residue.why}`);

  return result.ok ? 'ok' : 'failedDirty';
}

export function runBackupOnly(
  ctx: AppContext,
  reporter: Reporter,
  opts: { target: string; home: string; version: string },
): ExitCodeName {
  const project = findProject(ctx, opts.target, opts.home);
  if (!project) throw new CliError(`아는 프로젝트가 아닙니다: ${opts.target}`, 'usage');

  const root = backupRoot(ctx.env.toolDir);
  mkdirSync(root, { recursive: true });
  const backupId = newBackupId();

  const path = project.primaryCwd ?? project.dirPath;
  const handle = createBackup({
    root,
    backupId,
    version: opts.version,
    plan: {
      request: {
        src: path,
        dst: path,
        stateOnly: true,
        rewriteProse: false,
        policy: ctx.policy,
        platform: ctx.platform,
      },
      steps: [
        ...project.transcripts.map((t, i) => ({
          kind: 'rewrite-transcript' as const,
          id: `t${i}`,
          file: t.file,
          movesWithDir: false,
          affected: 0,
          total: t.lines,
        })),
        {
          kind: 'edit-config' as const,
          id: 'config',
          file: ctx.env.configPath,
          renameKey: false,
          githubRepos: [],
        },
        {
          kind: 'rewrite-history' as const,
          id: 'history',
          file: ctx.env.historyPath,
          affected: 0,
        },
      ],
      blockers: [],
      warnings: [],
      proseLeftBehind: 0,
    },
  });

  seal(handle);
  reporter.note(`백업 ${backupId}`);
  reporter.note(`되돌리기  claude-mv rollback ${backupId}`);
  return 'ok';
}

export async function runRemove(
  ctx: AppContext,
  reporter: Reporter,
  opts: { target: string; home: string; version: string; yes: boolean; force: boolean },
): Promise<ExitCodeName> {
  const project = findProject(ctx, opts.target, opts.home);
  if (!project) throw new CliError(`아는 프로젝트가 아닙니다: ${opts.target}`, 'usage');

  const path = project.primaryCwd;
  if (path && ctx.exists(path) && !opts.force) {
    throw new CliError(
      `${path} 는 아직 있습니다. 정말 상태만 지우려면 --force 를 쓰세요.`,
      'precondition',
    );
  }

  reporter.info(project);
  if (!opts.yes && !(await reporter.confirm('이 프로젝트의 Claude 상태를 지울까요?'))) {
    reporter.note('취소했습니다.');
    return 'ok';
  }

  const root = backupRoot(ctx.env.toolDir);
  mkdirSync(root, { recursive: true });
  const backupId = newBackupId();
  runBackupOnly(ctx, { ...reporter, note: () => {}, info: () => {} }, opts);

  const journal = Journal.resume(join(root, `${backupId}.journal.jsonl`));
  rmSync(project.dirPath, { recursive: true, force: true });
  journal.append({
    kind: 'committed',
    stepId: 'remove-project-dir',
    target: project.dirPath,
    previousState: 'existed',
  });

  if (path && ctx.index.configProjectKeys.includes(path)) {
    const text = readFileSync(ctx.env.configPath, 'utf8');
    const edits = planConfigRemoval(text, path);
    if (edits.length > 0) {
      await writeFileAtomic(ctx.env.configPath, applyEdits(text, edits));
      journal.append({
        kind: 'committed',
        stepId: 'remove-config-key',
        target: ctx.env.configPath,
        previousState: 'existed',
      });
    }
  }

  if (ctx.env.cacheRoot && ctx.index.cacheDirs.includes(project.dirName)) {
    rmSync(join(ctx.env.cacheRoot, project.dirName), { recursive: true, force: true });
  }

  reporter.note(`지웠습니다. 되돌리기  claude-mv rollback ${backupId}`);
  return 'ok';
}

export function runMerge(
  ctx: AppContext,
  reporter: Reporter,
  opts: { from: string; to: string; home: string; yes: boolean },
): ExitCodeName {
  const from = findProject(ctx, opts.from, opts.home);
  const to = findProject(ctx, opts.to, opts.home);
  if (!from) throw new CliError(`아는 프로젝트가 아닙니다: ${opts.from}`, 'usage');
  if (!to) throw new CliError(`아는 프로젝트가 아닙니다: ${opts.to}`, 'usage');

  let moved = 0;
  for (const entry of readdirSync(from.dirPath, { withFileTypes: true })) {
    const source = join(from.dirPath, entry.name);
    const target = join(to.dirPath, entry.name);

    if (existsSync(target)) {
      reporter.warn(`이미 있습니다, 건너뜁니다: ${entry.name}`);
      continue;
    }
    renameSync(source, target);
    moved++;
  }

  reporter.note(`${moved}개 항목을 옮겼습니다.`);
  if (readdirSync(from.dirPath).length === 0) rmSync(from.dirPath, { recursive: true });
  else reporter.warn(`${from.dirPath} 가 비지 않아 남겨둡니다.`);

  return 'ok';
}
