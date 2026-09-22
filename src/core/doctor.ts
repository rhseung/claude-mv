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
  /** 이 경로의 상태가 다른 어느 위치에도 남아 있는지. */
  alsoIn: ('config' | 'history' | 'cache')[];
  suggestions: Suggestion[];
};

export type DoctorReport = {
  orphans: DoctorEntry[];
  healthy: ProjectDirInfo[];
  other: DoctorEntry[];
  /** mangled 이름이 같아지는 서로 다른 경로들. 손실 인코딩이라 실제로 생길 수 있다. */
  collisions: { dirName: string; paths: string[] }[];
};

export type DoctorOptions = {
  index: ClaudeIndex;
  policy: CasePolicy;
  /** 이동 후보를 찾을 디렉터리들. 보통 살아 있는 프로젝트들의 부모. */
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

/**
 * mangled 이름이 같아지는 서로 다른 경로를 찾는다.
 *
 * `/a/b-c` 와 `/a/b/c` 가 같은 이름이 되는 손실 인코딩이라 실제로 벌어질 수 있고,
 * 그러면 두 프로젝트의 세션이 한 디렉터리에 섞인다.
 */
function findCollisions(index: ClaudeIndex): { dirName: string; paths: string[] }[] {
  const out: { dirName: string; paths: string[] }[] = [];
  for (const project of index.projects) {
    const distinct = [...project.cwdCensus.keys()].filter((p) => mangle(p) === project.dirName);
    if (distinct.length > 1) out.push({ dirName: project.dirName, paths: distinct });
  }
  return out;
}

/**
 * 고아가 된 경로가 어디로 갔는지 짐작한다.
 *
 * 확신이 없으면 아무 말도 하지 않는 쪽이 낫다. 틀린 추측을 따라가면 사용자가
 * 멀쩡한 다른 프로젝트의 상태를 덮어쓰게 된다.
 */
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

      // 부모가 그대로 살아 있으면 그 안에서 이름만 바뀌었을 가능성이 높다.
      if (root === parent && opts.exists(parent)) consider(candidate, 0.15, '같은 부모 안입니다');
    }
  }

  return [...found.values()]
    .filter((s) => s.confidence >= 0.4)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
}
