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

export type ProjectHealth =
  | 'healthy' // primaryCwd 가 실제로 있다
  | 'orphaned' // primaryCwd 가 사라졌다
  | 'undeterminable' // 트랜스크립트는 있는데 경로 필드가 없다
  | 'key-mismatch' // 디렉터리 이름이 어떤 cwd 의 mangle 결과와도 맞지 않는다
  | 'empty'; // 트랜스크립트가 없다

export type ProjectDirInfo = {
  dirName: string;
  dirPath: string;
  /** 구조 필드에서 모은 경로별 줄 수. 플랜 경로 등이 섞여 있다. */
  census: Map<string, number>;
  /** 작업 디렉터리 필드에만 나온 경로별 줄 수. 소유권 판정은 이걸로만 한다. */
  cwdCensus: Map<string, number>;
  /** 이 디렉터리가 키로 삼고 있는 경로. 판정 불가면 null. */
  primaryCwd: string | null;
  health: ProjectHealth;
  transcripts: TranscriptInfo[];
  /** memory/*.md, *.meta.json 등 파싱하지 않고 그대로 옮길 것들. */
  otherFiles: string[];
  bytes: number;
  lastActivityMs: number | null;
};

/**
 * 디렉터리가 어떤 경로를 키로 삼고 있는지 정한다.
 *
 * 그냥 최빈값을 쓰면 틀린다. 실제로 `-Users-rhseung` 디렉터리에는 `/Users/rhseung` 이 108 번,
 * `/Users/rhseung/.local/share/chezmoi` 가 349 번 나온다 (세션 도중 cd 한 것이다).
 * 최빈값을 고르면 chezmoi 가 뽑히는데, 그 디렉터리의 키는 `/Users/rhseung` 이다.
 * 그래서 mangle 결과가 디렉터리 이름과 맞는 후보를 먼저 본다.
 */
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

/** `<uuid>.jsonl` 과 `<uuid>/subagents/agent-<id>.jsonl` 을 모은다. */
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
        // <sessionUuid>/subagents/ 아래가 서브에이전트 트랜스크립트다.
        if (entry.name === 'subagents') await walk(full, 'subagent', sessionId);
        else if (kind === 'session') await walk(join(full), 'session', entry.name);
        else otherFiles.push(full);
        continue;
      }

      if (!entry.name.endsWith('.jsonl')) {
        // .meta.json 사이드카와 memory/*.md 는 JSONL 이 아니다. 파싱하지 않고 그대로 옮긴다.
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

  // 소유권은 작업 디렉터리 필드로만 따진다. census 에는 플랜 경로가 섞여 있어서
  // 그걸로 고르면 엉뚱한 값이 대표 경로가 될 수 있다.
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
  /** `ps lstart` 형식이지만 UTC 로 기록된다. 로컬 시각과 직접 비교하면 항상 어긋난다. */
  procStart?: string;
  updatedAt?: number;
  pidDomain?: string;
};

export type ClaudeIndex = {
  projects: ProjectDirInfo[];
  /** ~/.claude.json 의 projects 키. 진짜 절대 경로다. */
  configProjectKeys: string[];
  /** ~/.claude.json 의 githubRepoPaths. */
  githubRepoPaths: Record<string, string[]>;
  /** history.jsonl 의 project 필드별 줄 수. */
  historyProjects: Map<string, number>;
  /** 캐시 루트 아래의 mangled 디렉터리 이름들. */
  cacheDirs: string[];
  /** 실행 중인 Claude Code 프로세스 레지스트리. */
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
      } catch {
        // 잘린 줄은 건너뛴다.
      }
    }
  } catch {
    // history.jsonl 이 없을 수 있다.
  }
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
    // <pid>.<sha256>.key 사이드카는 소켓 인증용이라 우리가 볼 게 없다.
    if (!name.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(await readFile(join(sessionsDir, name), 'utf8')) as SessionRecord;
      if (typeof rec.pid === 'number' && typeof rec.cwd === 'string') out.push(rec);
    } catch {
      // 프로세스가 쓰는 중일 수 있다.
    }
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

/**
 * 어떤 경로의 상태가 어느 위치에 있는지 모은다.
 *
 * 여섯 위치는 서로 1:1 이 아니다. RST-FE-refac 는 projects 디렉터리와 캐시는 있는데
 * .claude.json 엔트리가 없고, gsainfoteam 은 그 반대다. 하나의 존재로 다른 하나를
 * 추론하면 안 되고 각자 따로 봐야 한다.
 */
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
