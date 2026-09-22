import { distance } from 'fastest-levenshtein';

import { mangle } from './mangle.js';
import { pathEquals, type CasePolicy } from './paths.js';

import type { ClaudeIndex, ProjectDirInfo } from './scan.js';

export type Suggestion = {
  candidate: string;
  confidence: number;
  evidence: string[];
};

export type DoctorEntry = {
  project: ProjectDirInfo;
  alsoIn: ('config' | 'history' | 'cache')[];
  suggestions: Suggestion[];
};

export type DoctorReport = {
  orphans: DoctorEntry[];
  healthy: ProjectDirInfo[];
  other: DoctorEntry[];
  collisions: { dirName: string; paths: string[] }[];
};

export type DoctorOptions = {
  index: ClaudeIndex;
  policy: CasePolicy;
  searchRoots: string[];
  listDirs: (dir: string) => string[];
  basename: (path: string) => string;
  dirname: (path: string) => string;
  join: (...parts: string[]) => string;
  exists: (path: string) => boolean;
};

export function doctor(opts: DoctorOptions): DoctorReport {
  const { index } = opts;
  const orphans: DoctorEntry[] = [];
  const healthy: ProjectDirInfo[] = [];
  const other: DoctorEntry[] = [];

  for (const project of index.projects) {
    if (project.health === 'healthy') {
      healthy.push(project);
      continue;
    }

    const entry: DoctorEntry = {
      project,
      alsoIn: locateElsewhere(index, project, opts.policy),
      suggestions: project.primaryCwd ? suggest(project.primaryCwd, opts) : [],
    };

    if (project.health === 'orphaned') orphans.push(entry);
    else other.push(entry);
  }

  return {
    orphans: orphans.sort((a, b) => b.project.bytes - a.project.bytes),
    healthy,
    other,
    collisions: findCollisions(index),
  };
}

function locateElsewhere(
  index: ClaudeIndex,
  project: ProjectDirInfo,
  policy: CasePolicy,
): ('config' | 'history' | 'cache')[] {
  const path = project.primaryCwd;
  if (!path) return [];

  const out: ('config' | 'history' | 'cache')[] = [];
  if (index.configProjectKeys.some((k) => pathEquals(k, path, policy))) out.push('config');
  if ([...index.historyProjects.keys()].some((p) => pathEquals(p, path, policy))) {
    out.push('history');
  }
  if (index.cacheDirs.includes(project.dirName)) out.push('cache');
  return out;
}

function findCollisions(index: ClaudeIndex): { dirName: string; paths: string[] }[] {
  const out: { dirName: string; paths: string[] }[] = [];
  for (const project of index.projects) {
    const distinct = [...project.cwdCensus.keys()].filter((p) => mangle(p) === project.dirName);
    if (distinct.length > 1) out.push({ dirName: project.dirName, paths: distinct });
  }
  return out;
}

function suggest(missing: string, opts: DoctorOptions): Suggestion[] {
  const name = opts.basename(missing);
  const parent = opts.dirname(missing);
  const found = new Map<string, Suggestion>();

  const consider = (candidate: string, weight: number, evidence: string): void => {
    if (!opts.exists(candidate) || pathEquals(candidate, missing, opts.policy)) return;
    const prev = found.get(candidate);
    if (prev) {
      prev.confidence = Math.min(1, prev.confidence + weight);
      prev.evidence.push(evidence);
      return;
    }
    found.set(candidate, { candidate, confidence: weight, evidence: [evidence] });
  };

  for (const root of new Set([parent, ...opts.searchRoots])) {
    for (const child of opts.listDirs(root)) {
      const candidate = opts.join(root, child);

      if (child === name) consider(candidate, 0.45, '이름이 같습니다');
      else if (distance(child, name) <= Math.max(2, Math.floor(name.length / 3))) {
        consider(candidate, 0.2, '이름이 비슷합니다');
      }

      if (root === parent && opts.exists(parent)) consider(candidate, 0.15, '같은 부모 안입니다');
    }
  }

  return [...found.values()]
    .filter((s) => s.confidence >= 0.4)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
}
