import { describe, expect, it } from 'vitest';

import { checkLocks, parseProcStart, type ProcessProbe } from '../src/core/lock.js';

import type { SessionRecord } from '../src/core/scan.js';

const SRC = '/Users/me/dev/proj';

const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  pid: 100,
  cwd: SRC,
  sessionId: 's',
  procStart: 'Tue Sep 22 12:42:11 2026',
  pidDomain: process.platform,
  ...over,
});

const probe = (over: Partial<ProcessProbe> = {}): ProcessProbe => ({
  exists: async () => true,
  startedAt: async () => Date.parse('2026-09-22T12:42:11Z'),
  self: 1,
  ...over,
});

describe('parseProcStart', () => {
  it('UTC 로 읽는다', () => {
    // 값은 ps lstart 모양이지만 UTC 로 기록된다. 로컬로 읽으면 타임존 차이만큼
    // 어긋나서 살아 있는 세션을 전부 죽은 것으로 판정하고 덮어쓰게 된다.
    expect(parseProcStart('Tue Sep 22 12:42:11 2026')).toBe(Date.parse('2026-09-22T12:42:11Z'));
  });

  it('없거나 이상하면 null', () => {
    expect(parseProcStart(undefined)).toBeNull();
    expect(parseProcStart('nonsense')).toBeNull();
  });
});

const opts = { src: SRC, policy: 'sensitive' as const, platform: process.platform };

describe('checkLocks', () => {
  it('같은 경로에서 도는 살아 있는 세션을 막는다', async () => {
    const report = await checkLocks([session()], { ...opts, probe: probe() });
    expect(report.blocking).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ verdict: 'live', relation: 'at-or-under' });
  });

  it('상위에서 도는 세션도 막는다', async () => {
    // 그 세션의 작업 트리 안에서 디렉터리가 사라지고, 트랜스크립트에는 옛 경로가 계속 쌓인다.
    const report = await checkLocks([session({ cwd: '/Users/me/dev' })], {
      ...opts,
      probe: probe(),
    });
    expect(report.findings[0]).toMatchObject({ relation: 'ancestor' });
    expect(report.blocking).toHaveLength(1);
  });

  it('--allow-ancestor 면 상위는 통과시킨다', async () => {
    const report = await checkLocks([session({ cwd: '/Users/me/dev' })], {
      ...opts,
      probe: probe(),
      allowAncestors: true,
    });
    expect(report.blocking).toHaveLength(0);
  });

  it('무관한 경로는 보지 않는다', async () => {
    const report = await checkLocks([session({ cwd: '/elsewhere' })], { ...opts, probe: probe() });
    expect(report.findings).toHaveLength(0);
  });

  it('죽은 프로세스는 막지 않는다', async () => {
    const report = await checkLocks([session()], {
      ...opts,
      probe: probe({ exists: async () => false }),
    });
    expect(report.findings[0]!.verdict).toBe('stale');
    expect(report.blocking).toHaveLength(0);
  });

  it('pid 재사용을 걸러낸다', async () => {
    const report = await checkLocks([session()], {
      ...opts,
      probe: probe({ startedAt: async () => Date.parse('2026-09-22T20:00:00Z') }),
    });
    expect(report.findings[0]).toMatchObject({ verdict: 'stale', why: 'pid 가 재사용되었습니다.' });
  });

  it('시작 시각을 모르면 살아 있다고 본다', async () => {
    const report = await checkLocks([session()], {
      ...opts,
      probe: probe({ startedAt: async () => null }),
    });
    expect(report.findings[0]!.verdict).toBe('unknown');
    expect(report.blocking).toHaveLength(1);
  });

  it('다른 OS 에서 기록된 세션은 판정하지 않는다', async () => {
    // 홈 디렉터리를 여러 기기에서 공유하면 남의 pid 가 섞인다.
    const report = await checkLocks([session({ pidDomain: 'plan9' as NodeJS.Platform })], {
      ...opts,
      probe: probe(),
    });
    expect(report.findings[0]!.verdict).toBe('unknown');
  });
});
