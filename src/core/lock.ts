import { isUnder, pathEquals, type CasePolicy } from './paths.js';

import type { SessionRecord } from './scan.js';

export type LockVerdict = 'live' | 'stale' | 'unknown';

export type LockFinding = {
  session: SessionRecord;
  verdict: LockVerdict;
  relation: 'at-or-under' | 'ancestor';
  why: string;
};

export type LockReport = {
  findings: LockFinding[];
  blocking: LockFinding[];
};

export type ProcessProbe = {
  exists: (pid: number) => Promise<boolean>;
  startedAt: (pid: number) => Promise<number | null>;
  self: number;
};

export function parseProcStart(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(`${value} UTC`);
  return Number.isNaN(parsed) ? null : parsed;
}

const START_TOLERANCE_MS = 2000;

export async function checkLocks(
  sessions: SessionRecord[],
  opts: {
    src: string;
    policy: CasePolicy;
    platform: NodeJS.Platform;
    probe: ProcessProbe;
    allowAncestors?: boolean;
  },
): Promise<LockReport> {
  const findings: LockFinding[] = [];

  for (const session of sessions) {
    const atOrUnder =
      pathEquals(session.cwd, opts.src, opts.policy) ||
      isUnder(session.cwd, opts.src, opts.policy, opts.platform);
    const ancestor = !atOrUnder && isUnder(opts.src, session.cwd, opts.policy, opts.platform);
    if (!atOrUnder && !ancestor) continue;

    const relation = atOrUnder ? 'at-or-under' : 'ancestor';
    findings.push({ session, relation, ...(await judge(session, opts.probe, opts.platform)) });
  }

  const blocking = findings.filter((f) => {
    if (f.verdict === 'stale') return false;
    if (f.relation === 'ancestor' && opts.allowAncestors) return false;
    return true;
  });

  return { findings, blocking };
}

async function judge(
  session: SessionRecord,
  probe: ProcessProbe,
  platform: NodeJS.Platform,
): Promise<{ verdict: LockVerdict; why: string }> {
  if (session.pidDomain && session.pidDomain !== platform) {
    return { verdict: 'unknown', why: `다른 OS(${session.pidDomain})에서 기록된 세션입니다.` };
  }

  if (!(await probe.exists(session.pid))) {
    return { verdict: 'stale', why: '프로세스가 없습니다.' };
  }

  const recorded = session.startedAtMs;
  const actual = await probe.startedAt(session.pid);
  if (recorded === null || actual === null) {
    return { verdict: 'unknown', why: '시작 시각을 확인하지 못했습니다.' };
  }

  if (Math.abs(recorded - actual) > START_TOLERANCE_MS) {
    return { verdict: 'stale', why: 'pid 가 재사용되었습니다.' };
  }

  return { verdict: 'live', why: '실행 중입니다.' };
}
