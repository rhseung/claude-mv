import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { createFakeClaudeHome, type HomeSpec } from './claude-home.js';
import { scan } from '../../src/core/scan.js';

import type { LockReport } from '../../src/core/lock.js';
import type { MoveRequest, PlanContext } from '../../src/core/plan.js';

export const noLocks: LockReport = { findings: [], blocking: [] };

export type ScenarioOverrides = {
  request?: Partial<MoveRequest>;
  context?: Partial<PlanContext>;
};

export type Scenario = Awaited<ReturnType<typeof scenario>>;

export async function scenario(
  spec: HomeSpec,
  src: string,
  dst: string,
  overrides: ScenarioOverrides = {},
) {
  const home = createFakeClaudeHome(spec);

  const request: MoveRequest = {
    src,
    dst,
    stateOnly: false,
    rewriteProse: false,
    policy: 'sensitive',
    platform: process.platform,
    ...overrides.request,
  };

  const context: PlanContext & { toolDir: string } = {
    index: await scan(home),
    configPath: home.configPath,
    historyPath: home.historyPath,
    projectsDir: home.projectsDir,
    plansDir: join(home.home, 'plans'),
    cacheRoot: home.cacheRoot,
    toolDir: join(home.home, '.claude-mv'),
    fileExists: existsSync,
    srcExists: existsSync(src),
    dstExists: existsSync(dst),
    locks: noLocks,
    ...overrides.context,
  };

  return { home, request, context };
}
