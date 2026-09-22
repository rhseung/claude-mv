import { isUnder, pathEquals, type CasePolicy } from './paths.js';

import type { SessionRecord } from './scan.js';

export type LockVerdict = 'live' | 'stale' | 'unknown';

export type LockFinding = {
  session: SessionRecord;
  verdict: LockVerdict;
  /** src 자체에서 도는 세션인지, src 를 품은 상위에서 도는 세션인지. */
  relation: 'at-or-under' | 'ancestor';
  why: string;
};

export type LockReport = {
  findings: LockFinding[];
  /** 진행을 막아야 하는 것들. unknown 은 살아 있다고 본다. */
  blocking: LockFinding[];
};

export type ProcessProbe = {
  /** 해당 pid 가 존재하는가. */
  exists: (pid: number) => Promise<boolean>;
  /** 프로세스 시작 시각(ms). 알 수 없으면 null. */
  startedAt: (pid: number) => Promise<number | null>;
  /** 우리 자신의 pid. 스스로를 막지 않기 위해 쓴다. */
  self: number;
};

/**
 * 레지스트리의 `procStart` 를 시각으로 바꾼다.
 *
 * 여기에 함정이 있다. 값은 `ps lstart` 와 같은 모양이지만 **UTC 로 기록**되는데,
 * `ps` 는 로컬 시각을 출력한다. 실제로 저장값이 `Tue Sep 22 12:51:04 2026` 일 때
 * `ps` 는 `Tue Sep 22 21:51:04 2026` 을 준다 (KST=UTC+9). 같은 순간이다.
 * 문자열로 비교하면 항상 어긋나고, 그러면 살아 있는 세션을 전부 죽은 것으로 판정해
 * 그대로 덮어쓰게 된다.
 */
export function parseProcStart(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(`${value} UTC`);
  return Number.isNaN(parsed) ? null : parsed;
}

/** pid 재사용을 걸러내기 위한 허용 오차. ps 는 초 단위로 자른다. */
const START_TOLERANCE_MS = 2000;

export async function checkLocks(
  sessions: SessionRecord[],
  opts: {
    src: string;
    policy: CasePolicy;
    platform: NodeJS.Platform;
    probe: ProcessProbe;
    /** 상위에서 도는 세션도 막을지. 기본은 막는다. */
    allowAncestors?: boolean;
  },
): Promise<LockReport> {
  const findings: LockFinding[] = [];

  for (const session of sessions) {
    const atOrUnder =
      pathEquals(session.cwd, opts.src, opts.policy) ||
      isUnder(session.cwd, opts.src, opts.policy, opts.platform);
    // src 를 품은 상위에서 시작한 세션도 영향을 받는다. 그 세션의 작업 트리 안에서
    // 디렉터리가 사라지는 것이고, 트랜스크립트에도 옛 경로가 계속 쌓인다.
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
  // 홈 디렉터리를 여러 기기에서 공유하면 남의 OS 에서 쓴 레코드가 섞인다.
  // 그런 pid 는 우리 기기에서 아무 의미가 없다.
  if (session.pidDomain && session.pidDomain !== platform) {
    return { verdict: 'unknown', why: `다른 OS(${session.pidDomain})에서 기록된 세션입니다.` };
  }

  if (!(await probe.exists(session.pid))) {
    return { verdict: 'stale', why: '프로세스가 없습니다.' };
  }

  const recorded = parseProcStart(session.procStart);
  const actual = await probe.startedAt(session.pid);
  if (recorded === null || actual === null) {
    return { verdict: 'unknown', why: '시작 시각을 확인하지 못했습니다.' };
  }

  if (Math.abs(recorded - actual) > START_TOLERANCE_MS) {
    return { verdict: 'stale', why: 'pid 가 재사용되었습니다.' };
  }

  return { verdict: 'live', why: '실행 중입니다.' };
}
