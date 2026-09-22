import { execFile } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { temporaryDirectory } from 'tempy';
import { beforeAll, describe, expect, it } from 'vitest';

import { mangle } from '../src/core/mangle.js';

const run = promisify(execFile);
const HOOK = join(import.meta.dirname, '..', 'plugin', 'hooks', 'session-start.mjs');

async function callHook(cwd: string, configDir: string): Promise<string> {
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
    expect(() => statSync(HOOK)).not.toThrow();
  });

  it('기록이 있는 디렉터리에서는 아무 말도 하지 않는다', async () => {
    const live = temporaryDirectory();
    const home = fakeHome({ projects: [live], configKeys: [live] });
    expect(await callHook(live, home)).toBe('');
  });

  it('옮겨온 것으로 보이면 경고한다', async () => {
    const parent = temporaryDirectory();
    const gone = join(parent, 'proj');
    const now = join(parent, 'proj-renamed');
    mkdirSync(now, { recursive: true });

    const home = fakeHome({ projects: [gone], configKeys: [gone] });
    const out = await callHook(now, home);

    const message = JSON.parse(out).systemMessage as string;
    expect(message).toContain('claude-mv');
    expect(message).toContain(gone);
    expect(message).toContain('--state-only');
  });

  it('원본이 아직 살아 있으면 경고하지 않는다', async () => {
    const parent = temporaryDirectory();
    const alive = join(parent, 'proj');
    const other = join(parent, 'proj-renamed');
    mkdirSync(alive, { recursive: true });
    mkdirSync(other, { recursive: true });

    const home = fakeHome({ projects: [alive], configKeys: [alive] });
    expect(await callHook(other, home)).toBe('');
  });

  it('후보가 동점이면 경고하지 않는다', async () => {
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
    expect(statSync(HOOK).size).toBeLessThan(16 * 1024);
  });
});
