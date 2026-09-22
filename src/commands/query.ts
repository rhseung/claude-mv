import { CliError, type ExitCodeName } from '../cli/exit.js';
import { doctor } from '../core/doctor.js';
import { mangle } from '../core/mangle.js';
import { normalizePath, pathEquals } from '../core/paths.js';
import { pathHelpers, searchRoots, type AppContext } from '../shared/context.js';

import type { ProjectDirInfo } from '../core/scan.js';
import type { Reporter } from '../render/reporter.js';

export type ListOptions = {
  orphansOnly: boolean;
  sort: 'activity' | 'size' | 'path';
};

export function runList(ctx: AppContext, reporter: Reporter, opts: ListOptions): ExitCodeName {
  let projects = ctx.index.projects;
  if (opts.orphansOnly) projects = projects.filter((p) => p.health !== 'healthy');

  const sorted = [...projects].sort((a, b) => {
    if (opts.sort === 'size') return b.bytes - a.bytes;
    if (opts.sort === 'activity') return (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0);
    return (a.primaryCwd ?? a.dirName).localeCompare(b.primaryCwd ?? b.dirName);
  });

  reporter.list(sorted);
  return sorted.some((p) => p.health === 'orphaned') ? 'orphans' : 'ok';
}

export function findProject(
  ctx: AppContext,
  needle: string,
  home: string,
): ProjectDirInfo | undefined {
  const byDirName = ctx.index.projects.find((p) => p.dirName === needle);
  if (byDirName) return byDirName;

  const normalized = normalizePath(needle, { platform: ctx.platform, home, realpath: false });
  return (
    ctx.index.projects.find(
      (p) => p.primaryCwd && pathEquals(p.primaryCwd, normalized, ctx.policy),
    ) ?? ctx.index.projects.find((p) => p.dirName === mangle(normalized))
  );
}

export function runInfo(
  ctx: AppContext,
  reporter: Reporter,
  opts: { target: string; home: string },
): ExitCodeName {
  const project = findProject(ctx, opts.target, opts.home);
  if (!project) throw new CliError(`아는 프로젝트가 아닙니다: ${opts.target}`, 'usage');

  reporter.info(project);
  return project.health === 'orphaned' ? 'orphans' : 'ok';
}

export function runDoctor(ctx: AppContext, reporter: Reporter): ExitCodeName {
  const report = doctor({
    index: ctx.index,
    policy: ctx.policy,
    searchRoots: searchRoots(ctx.index, ctx.env.claudeHome.replace(/\/\.claude$/, '')),
    listDirs: ctx.listDirs,
    ...pathHelpers,
  });

  reporter.doctor(report);
  return report.orphans.length > 0 ? 'orphans' : 'ok';
}
