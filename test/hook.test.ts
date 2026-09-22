import { execFile } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { temporaryDirectory } from 'tempy';
import { beforeAll, describe, expect, it } from 'vitest';

import { mangle } from '../src/core/mangle.js';

const run = promisify(execFile);
const HOOK = join(import.meta.dirname, '..', 'plugin', 'hooks', 'session-start.mjs');

/**
 * 배포되는 산출물을 그대로 실행한다. 소스만 테스트하면 번들이 깨진 채로 나가도 모른다.
 */
async function callHook(cwd: string, configDir: string): Promise<string> {
  // process.execPath 를 쓰면 PATH 를 물려줄 필요가 없고, 테스트를 돌리는 것과
  // 같은 node 로 실행된다는 것도 보장된다.
  const child = run(process.execPath, [HOOK], { env: { CLAUDE_CONFIG_DIR: configDir } });
  child.child.stdin?.end(JSON.stringify({ cwd, hook_event_name: 'SessionStart' }));
  const { stdout } = await child;
  return stdout;
}

function fakeHome(spec: { projects: string[]; configKeys: string[] }): string {
  const home = temporaryDirectory();
  mkdirSync(join(home, 'projects'), { recursive: true });

  for (const path of spec.projects) {
    mkdirSync(join(home, 'projects', mangle(path)), { recursive: true });
  }
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({ projects: Object.fromEntries(spec.configKeys.map((k) => [k, {}])) }),
  );
  return home;
}

describe('session-start 훅', () => {
  beforeAll(() => {
    // 훅 번들이 빌드되어 있어야 한다. CI 는 소스와의 동기화도 따로 검사한다.
    expect(() => statSync(HOOK)).not.toThrow();
  });

  it('기록이 있는 디렉터리에서는 아무 말도 하지 않는다', async () => {
    const live = temporaryDirectory();
    const home = fakeHome({ projects: [live], configKeys: [live] });
    expect(await callHook(live, home)).toBe('');
  });

  it('옮겨온 것으로 보이면 경고한다', async () => {
    const parent = temporaryDirectory();
    const gone = join(parent, 'proj'); // 만들지 않는다 = 사라진 경로
    const now = join(parent, 'proj-renamed');
    mkdirSync(now, { recursive: true });

    const home = fakeHome({ projects: [gone], configKeys: [gone] });
    const out = await callHook(now, home);

    expect(out).toContain('claude-mv');
    expect(out).toContain(gone);
    expect(JSON.parse(out).systemMessage).toContain('--state-only');
  });

  it('원본이 아직 살아 있으면 경고하지 않는다', async () => {
    // 이름만 닮은 남의 프로젝트다.
    const parent = temporaryDirectory();
    const alive = join(parent, 'proj');
    const other = join(parent, 'proj-renamed');
    mkdirSync(alive, { recursive: true });
    mkdirSync(other, { recursive: true });

    const home = fakeHome({ projects: [alive], configKeys: [alive] });
    expect(await callHook(other, home)).toBe('');
  });

  it('후보가 동점이면 경고하지 않는다', async () => {
    // 틀린 추측을 따라가면 멀쩡한 다른 프로젝트의 상태를 덮어쓰게 된다.
    const parent = temporaryDirectory();
    const a = join(parent, 'proj');
    const b = join(parent, 'proj');
    const now = join(parent, 'proj-renamed');
    mkdirSync(now, { recursive: true });

    const home = fakeHome({ projects: [a, `${b}-2`], configKeys: [a, `${b}-2`] });
    expect(await callHook(now, home)).toBe('');
  });

  it('config 가 깨져 있어도 조용히 끝낸다', async () => {
    const home = temporaryDirectory();
    mkdirSync(join(home, 'projects'), { recursive: true });
    writeFileSync(join(home, '.claude.json'), '{ 깨진 json');

    const now = temporaryDirectory();
    expect(await callHook(now, home)).toBe('');
  });

  it('번들이 작아야 한다', () => {
    // 세션이 열릴 때마다 node 가 이걸 읽고 파싱한다. 의존성이 새어 들어오면 여기서 걸린다.
    expect(statSync(HOOK).size).toBeLessThan(16 * 1024);
  });
});
