import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { censusTranscript, readLines, type TranscriptCensus } from './jsonl.js';
import { mangle } from './mangle.js';
import { pathEquals, type CasePolicy } from './paths.js';

export type TranscriptKind = 'session' | 'subagent';

export type TranscriptInfo = TranscriptCensus & {
  kind: TranscriptKind;
  sessionId: string;
  agentId?: string;
  mtimeMs: number;
};

export type ProjectHealth = 'healthy' | 'orphaned' | 'undeterminable' | 'key-mismatch' | 'empty';

export type ProjectDirInfo = {
  dirName: string;
  dirPath: string;
  census: Map<string, number>;
  cwdCensus: Map<string, number>;
  primaryCwd: string | null;
  health: ProjectHealth;
  transcripts: TranscriptInfo[];
  otherFiles: string[];
  bytes: number;
  lastActivityMs: number | null;
};

export function pickPrimaryCwd(
  dirName: string,
  census: Map<string, number>,
): { cwd: string | null; matchedKey: boolean } {
  const byCount = [...census].sort((a, b) => b[1] - a[1]);
  const matching = byCount.find(([path]) => mangle(path) === dirName);
  if (matching) return { cwd: matching[0], matchedKey: true };
  return { cwd: byCount[0]?.[0] ?? null, matchedKey: false };
}

function classify(
  primaryCwd: string | null,
  matchedKey: boolean,
  hasTranscripts: boolean,
  exists: boolean,
): ProjectHealth {
  if (!hasTranscripts) return 'empty';
  if (primaryCwd === null) return 'undeterminable';
  if (!matchedKey) return 'key-mismatch';
  return exists ? 'healthy' : 'orphaned';
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function collectTranscripts(
  dirPath: string,
): Promise<{ transcripts: TranscriptInfo[]; otherFiles: string[] }> {
  const transcripts: TranscriptInfo[] = [];
  const otherFiles: string[] = [];

  const walk = async (dir: string, kind: TranscriptKind, sessionId?: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === 'subagents') await walk(full, 'subagent', sessionId);
        else if (kind === 'session') await walk(join(full), 'session', entry.name);
        else otherFiles.push(full);
        continue;
      }

      if (!entry.name.endsWith('.jsonl')) {
        otherFiles.push(full);
        continue;
      }

      const census = await censusTranscript(full);
      transcripts.push({
        ...census,
        kind,
        sessionId: sessionId ?? entry.name.replace(/\.jsonl$/, ''),
        agentId: kind === 'subagent' ? entry.name.replace(/\.jsonl$/, '') : undefined,
        mtimeMs: (await stat(full)).mtimeMs,
      });
    }
  };

  await walk(dirPath, 'session');
  return { transcripts, otherFiles };
}

export async function scanProjectDir(
  projectsDir: string,
  dirName: string,
): Promise<ProjectDirInfo> {
  const dirPath = join(projectsDir, dirName);
  const { transcripts, otherFiles } = await collectTranscripts(dirPath);

  const census = new Map<string, number>();
  const cwdCensus = new Map<string, number>();
  for (const t of transcripts) {
    for (const [path, count] of t.paths) census.set(path, (census.get(path) ?? 0) + count);
    for (const [path, count] of t.cwds) cwdCensus.set(path, (cwdCensus.get(path) ?? 0) + count);
  }

  const { cwd, matchedKey } = pickPrimaryCwd(dirName, cwdCensus);
  const health = classify(cwd, matchedKey, transcripts.length > 0, cwd ? await exists(cwd) : false);

  return {
    dirName,
    dirPath,
    census,
    cwdCensus,
    primaryCwd: cwd,
    health,
    transcripts,
    otherFiles,
    bytes: transcripts.reduce((sum, t) => sum + t.bytes, 0),
    lastActivityMs: transcripts.length ? Math.max(...transcripts.map((t) => t.mtimeMs)) : null,
  };
}

export type SessionRecord = {
  pid: number;
  cwd: string;
  sessionId: string;
  startedAtMs: number | null;
  updatedAt?: number;
  pidDomain?: NodeJS.Platform;
};

type RawSessionRecord = Omit<SessionRecord, 'startedAtMs'> & { procStart?: string };

const PROC_START_IS_UTC = ' UTC';

export function parseProcStart(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value + PROC_START_IS_UTC);
  return Number.isNaN(parsed) ? null : parsed;
}

export type ClaudeIndex = {
  projects: ProjectDirInfo[];
  configProjectKeys: string[];
  githubRepoPaths: Record<string, string[]>;
  historyProjects: Map<string, number>;
  cacheDirs: string[];
  sessions: SessionRecord[];
};

async function readConfig(
  configPath: string,
): Promise<{ keys: string[]; githubRepoPaths: Record<string, string[]> }> {
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as {
      projects?: Record<string, unknown>;
      githubRepoPaths?: Record<string, string[]>;
    };
    return {
      keys: Object.keys(parsed.projects ?? {}),
      githubRepoPaths: parsed.githubRepoPaths ?? {},
    };
  } catch {
    return { keys: [], githubRepoPaths: {} };
  }
}

async function readHistory(historyPath: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  try {
    for await (const line of readLines(historyPath)) {
      if (line.raw.length === 0) continue;
      try {
        const rec = JSON.parse(line.raw.toString('utf8')) as { project?: unknown };
        if (typeof rec.project === 'string') {
          counts.set(rec.project, (counts.get(rec.project) ?? 0) + 1);
        }
      } catch {}
    }
  } catch {}
  return counts;
}

async function readSessions(sessionsDir: string): Promise<SessionRecord[]> {
  const out: SessionRecord[] = [];
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return out;
  }

  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await readFile(join(sessionsDir, name), 'utf8')) as RawSessionRecord;
      if (typeof raw.pid !== 'number' || typeof raw.cwd !== 'string') continue;

      const { procStart, ...rest } = raw;
      out.push({ ...rest, startedAtMs: parseProcStart(procStart) });
    } catch {}
  }
  return out;
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export type ScanTarget = {
  projectsDir: string;
  configPath: string;
  historyPath: string;
  sessionsDir: string;
  cacheRoot: string | null;
};

export async function scan(target: ScanTarget): Promise<ClaudeIndex> {
  const dirNames = await listDirs(target.projectsDir);
  const config = await readConfig(target.configPath);

  return {
    projects: await Promise.all(dirNames.map((name) => scanProjectDir(target.projectsDir, name))),
    configProjectKeys: config.keys,
    githubRepoPaths: config.githubRepoPaths,
    historyProjects: await readHistory(target.historyPath),
    cacheDirs: target.cacheRoot ? await listDirs(target.cacheRoot) : [],
    sessions: await readSessions(target.sessionsDir),
  };
}

export function locate(
  index: ClaudeIndex,
  path: string,
  policy: CasePolicy,
): {
  projectDirs: ProjectDirInfo[];
  inConfig: boolean;
  githubRepos: string[];
  historyLines: number;
  cacheDir: string | null;
} {
  const wanted = mangle(path);
  return {
    projectDirs: index.projects.filter(
      (p) => p.dirName === wanted || [...p.census.keys()].some((c) => pathEquals(c, path, policy)),
    ),
    inConfig: index.configProjectKeys.some((k) => pathEquals(k, path, policy)),
    githubRepos: Object.entries(index.githubRepoPaths)
      .filter(([, paths]) => paths.some((p) => pathEquals(p, path, policy)))
      .map(([repo]) => repo),
    historyLines: [...index.historyProjects]
      .filter(([p]) => pathEquals(p, path, policy))
      .reduce((sum, [, n]) => sum + n, 0),
    cacheDir: index.cacheDirs.includes(wanted) ? wanted : null,
  };
}
