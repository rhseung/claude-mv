import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { resolveClaudeEnv, type ClaudeEnv } from './env.js';
import { createProcessProbe } from './process.js';
import { defaultCasePolicy, probeCasePolicy, type CasePolicy } from '../core/paths.js';
import { scan, type ClaudeIndex } from '../core/scan.js';

export type AppContext = {
  env: ClaudeEnv;
  policy: CasePolicy;
  platform: NodeJS.Platform;
  probe: ReturnType<typeof createProcessProbe>;
  index: ClaudeIndex;
  exists: (path: string) => boolean;
  listDirs: (dir: string) => string[];
};

export async function createContext(opts?: { claudeHome?: string }): Promise<AppContext> {
  const env = resolveClaudeEnv(opts);
  const platform = env.platform;

  return {
    env,
    platform,
    policy: probeCasePolicy(env.claudeHome, defaultCasePolicy(platform)),
    probe: createProcessProbe(platform),
    index: await scan(env),
    exists: existsSync,
    listDirs,
  };
}

export function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function searchRoots(index: ClaudeIndex, home: string): string[] {
  const roots = new Set<string>([
    join(home, 'Developer'),
    join(home, 'Projects'),
    join(home, 'src'),
    join(home, 'code'),
  ]);

  for (const project of index.projects) {
    if (project.health === 'healthy' && project.primaryCwd) roots.add(dirname(project.primaryCwd));
  }

  return [...roots].filter((r) => {
    try {
      return statSync(r).isDirectory();
    } catch {
      return false;
    }
  });
}

export const pathHelpers = { basename, dirname, join, exists: existsSync };
