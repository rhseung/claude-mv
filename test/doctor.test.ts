import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { temporaryDirectory } from 'tempy';
import { describe, expect, it } from 'vitest';

import { createFakeClaudeHome, type HomeSpec } from './fixtures/claude-home.js';
import { records } from './fixtures/transcript.js';
import { doctor } from '../src/core/doctor.js';
import { scan } from '../src/core/scan.js';

/**
 * 건강 판정은 scan 이 실제 파일시스템으로 한다. 그래서 가짜 세계를 주입하는 대신
 * 진짜 임시 디렉터리를 만든다 - 실제로 타는 코드 경로를 그대로 시험한다.
 */
async function report(build: (world: string) => HomeSpec, live: string[] = []) {
  const world = temporaryDirectory();
  for (const path of live) mkdirSync(join(world, path), { recursive: true });

  const target = createFakeClaudeHome(build(world));
  const index = await scan(target);

  const report = doctor({
    index,
    policy: 'sensitive',
    searchRoots: [world],
    listDirs: (dir) => (existsSync(dir) ? readdirNames(dir) : []),
    basename,
    dirname,
    join,
    exists: existsSync,
  });

  return { ...report, world };
}

function readdirNames(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

describe('doctor', () => {
  it('사라진 경로를 고아로 잡는다', async () => {
    const result = await report((w) => {
      const gone = join(w, 'gone');
      return { projects: [{ path: gone, sessions: { s1: [records.user(gone)] } }] };
    });

    expect(result.orphans).toHaveLength(1);
    expect(result.healthy).toHaveLength(0);
  });

  it('살아 있는 경로는 건강하다', async () => {
    const result = await report(
      (w) => {
        const alive = join(w, 'alive');
        return { projects: [{ path: alive, sessions: { s1: [records.user(alive)] } }] };
      },
      ['alive'],
    );

    expect(result.orphans).toHaveLength(0);
    expect(result.healthy).toHaveLength(1);
  });

  it('상태가 어느 위치에 남아 있는지 알려준다', async () => {
    const result = await report((w) => {
      const gone = join(w, 'gone');
      return {
        projects: [{ path: gone, sessions: { s1: [records.user(gone)] } }],
        configProjects: [gone],
        history: [{ project: gone, count: 2 }],
        cacheFor: [gone],
      };
    });

    expect(result.orphans[0]!.alsoIn.sort()).toEqual(['cache', 'config', 'history']);
  });

  it('같은 이름의 디렉터리를 이동 후보로 제안한다', async () => {
    const result = await report(
      (w) => {
        const gone = join(w, 'nested', 'proj');
        return { projects: [{ path: gone, sessions: { s1: [records.user(gone)] } }] };
      },
      ['proj'],
    );

    const [suggestion] = result.orphans[0]!.suggestions;
    expect(suggestion?.candidate).toBe(join(result.world, 'proj'));
    expect(suggestion?.confidence).toBeGreaterThanOrEqual(0.4);
  });

  it('확신이 없으면 아무 제안도 하지 않는다', async () => {
    // 틀린 추측을 따라가면 멀쩡한 다른 프로젝트의 상태를 덮어쓰게 된다.
    const result = await report(
      (w) => {
        const gone = join(w, 'nested', 'proj');
        return { projects: [{ path: gone, sessions: { s1: [records.user(gone)] } }] };
      },
      ['completely-different-name'],
    );

    expect(result.orphans[0]!.suggestions).toEqual([]);
  });

  it('판정 불가와 빈 디렉터리는 고아와 구분한다', async () => {
    const result = await report((w): HomeSpec => ({
      projects: [
        { path: join(w, 'nopaths'), sessions: { s1: [records.pathless()] } },
        { path: join(w, 'empty'), sessions: {} },
      ],
    }));

    expect(result.orphans).toHaveLength(0);
    expect(result.other.map((e) => e.project.health).sort()).toEqual(['empty', 'undeterminable']);
  });
});
