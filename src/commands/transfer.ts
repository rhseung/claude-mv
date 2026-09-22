import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import * as tar from 'tar';

import { findProject } from './query.js';
import { CliError, type ExitCodeName } from '../cli/exit.js';
import { normalizePath } from '../core/paths.js';

import type { Reporter } from '../render/reporter.js';
import type { AppContext } from '../shared/context.js';

export type Bundle = {
  version: 1;
  tool: 'claude-mv';
  originalPath: string;
  dirName: string;
  exportedAt: number;
  platform: NodeJS.Platform;
};

const MANIFEST = 'claude-mv-bundle.json';

export function runExport(
  ctx: AppContext,
  reporter: Reporter,
  opts: { target: string; out?: string; home: string },
): ExitCodeName {
  const project = findProject(ctx, opts.target, opts.home);
  if (!project) throw new CliError(`아는 프로젝트가 아닙니다: ${opts.target}`, 'usage');

  const bundle: Bundle = {
    version: 1,
    tool: 'claude-mv',
    originalPath: project.primaryCwd ?? project.dirPath,
    dirName: project.dirName,
    exportedAt: Date.now(),
    platform: ctx.platform,
  };

  const staging = mkdtempSync(join(tmpdir(), 'claude-mv-export-'));
  writeFileSync(join(staging, MANIFEST), JSON.stringify(bundle, null, 2));
  cpSync(project.dirPath, join(staging, 'projects', project.dirName), { recursive: true });

  const out = opts.out ?? `${basename(bundle.originalPath)}-claude-state.tgz`;
  tar.create({ gzip: true, file: out, sync: true, cwd: staging }, [MANIFEST, 'projects']);
  rmSync(staging, { recursive: true, force: true });

  reporter.note(`${out} 에 저장했습니다.`);
  return 'ok';
}

export function readBundle(file: string): Bundle {
  const staging = mkdtempSync(join(tmpdir(), 'claude-mv-peek-'));
  tar.extract({ file, sync: true, cwd: staging }, [MANIFEST]);

  const manifestPath = join(staging, MANIFEST);
  if (!existsSync(manifestPath)) {
    throw new CliError('claude-mv 로 만든 번들이 아닙니다.', 'usage');
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Bundle;
}

export function runImport(
  ctx: AppContext,
  reporter: Reporter,
  opts: { file: string; to?: string; home: string },
): { code: ExitCodeName; migrateFrom?: string; migrateTo?: string } {
  const bundle = readBundle(opts.file);

  const staging = mkdtempSync(join(tmpdir(), 'claude-mv-import-'));
  tar.extract({ file: opts.file, sync: true, cwd: staging });

  const source = join(staging, 'projects', bundle.dirName);
  if (!existsSync(source)) throw new CliError('번들에 project 디렉터리가 없습니다.', 'usage');

  const destination = join(ctx.env.projectsDir, bundle.dirName);
  if (existsSync(destination)) {
    throw new CliError(
      `이미 있는 상태를 덮어쓰지 않습니다: ${bundle.dirName}. merge 를 쓰세요.`,
      'conflict',
    );
  }

  mkdirSync(ctx.env.projectsDir, { recursive: true });
  cpSync(source, destination, { recursive: true });
  rmSync(staging, { recursive: true, force: true });

  reporter.note(`${bundle.originalPath} 의 상태를 들여왔습니다.`);

  if (!opts.to) return { code: 'ok' };

  const to = normalizePath(opts.to, { platform: ctx.platform, home: opts.home, realpath: false });
  reporter.note(`이어서 ${bundle.originalPath} -> ${to} 로 이관합니다.`);
  return { code: 'ok', migrateFrom: bundle.originalPath, migrateTo: to };
}
