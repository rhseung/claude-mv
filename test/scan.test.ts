import { describe, expect, it } from 'vitest';

import { createFakeClaudeHome } from './fixtures/claude-home.js';
import { records } from './fixtures/transcript.js';
import { mangle } from '../src/core/mangle.js';
import { locate, pickPrimaryCwd, scan } from '../src/core/scan.js';

const HOME = '/Users/me';
const CHEZMOI = '/Users/me/.local/share/chezmoi';

describe('pickPrimaryCwd', () => {
  it('최빈값이 아니라 디렉터리 이름과 맞는 경로를 고른다', () => {
    const census = new Map([
      [CHEZMOI, 349],
      [HOME, 108],
    ]);
    const picked = pickPrimaryCwd(mangle(HOME), census);
    expect(picked.cwd).toBe(HOME);
    expect(picked.matchedKey).toBe(true);
  });

  it('맞는 게 없으면 최빈값을 쓰되 key-mismatch 로 표시한다', () => {
    const picked = pickPrimaryCwd('-something-else', new Map([[HOME, 5]]));
    expect(picked.cwd).toBe(HOME);
    expect(picked.matchedKey).toBe(false);
  });

  it('census 가 비면 판정 불가', () => {
    expect(pickPrimaryCwd('-a-b', new Map()).cwd).toBeNull();
  });
});

describe('scan', () => {
  it('상태를 분류한다', async () => {
    const target = createFakeClaudeHome({
      projects: [
        { path: HOME, sessions: { s1: [records.user(HOME)] } },
        { path: '/gone/for/good', sessions: { s2: [records.user('/gone/for/good')] } },
        { path: '/empty/one', sessions: {} },
        { path: '/no/paths', sessions: { s3: [records.pathless()] } },
      ],
    });

    const index = await scan(target);
    const health = Object.fromEntries(index.projects.map((p) => [p.dirName, p.health]));

    expect(health[mangle('/gone/for/good')]).toBe('orphaned');
    expect(health[mangle('/empty/one')]).toBe('empty');
    expect(health[mangle('/no/paths')]).toBe('undeterminable');
  });

  it('subagent 트랜스크립트와 meta.json 사이드카를 구분한다', async () => {
    const target = createFakeClaudeHome({
      projects: [
        {
          path: HOME,
          sessions: { s1: [records.user(HOME)] },
          subagents: { s1: { 'agent-abc': [records.user('/other/place')] } },
        },
      ],
    });

    const index = await scan(target);
    const project = index.projects[0]!;

    expect(project.transcripts.map((t) => t.kind).sort()).toEqual(['session', 'subagent']);
    expect([...project.census.keys()].sort()).toEqual([HOME, '/other/place']);
    expect(project.otherFiles.some((f) => f.endsWith('.meta.json'))).toBe(true);
  });
});

describe('locate', () => {
  it('자기 디렉터리와 부모 디렉터리를 모두 찾는다', async () => {
    const PARENT = '/Users/me/dev';
    const CHILD = '/Users/me/dev/proj';
    const target = createFakeClaudeHome({
      projects: [
        {
          path: PARENT,
          sessions: { s1: [records.user(PARENT)] },
          subagents: { s1: { 'agent-1': [records.user(CHILD)] } },
        },
        { path: CHILD, sessions: { s2: [records.user(CHILD)] } },
      ],
      cacheFor: [CHILD],
    });

    const index = await scan(target);
    const found = locate(index, CHILD, 'sensitive');

    expect(found.projectDirs.map((d) => d.dirName).sort()).toEqual(
      [mangle(PARENT), mangle(CHILD)].sort(),
    );
    expect(found.cacheDir).toBe(mangle(CHILD));
  });

  it('여섯 위치는 서로 독립이다', async () => {
    const A = '/Users/me/only-dir';
    const B = '/Users/me/only-config';
    const target = createFakeClaudeHome({
      projects: [{ path: A, sessions: { s1: [records.user(A)] } }],
      configProjects: [B],
      cacheFor: [A],
      history: [{ project: B, count: 3 }],
    });

    const index = await scan(target);

    const a = locate(index, A, 'sensitive');
    expect(a.projectDirs).toHaveLength(1);
    expect(a.inConfig).toBe(false);
    expect(a.historyLines).toBe(0);

    const b = locate(index, B, 'sensitive');
    expect(b.projectDirs).toHaveLength(0);
    expect(b.inConfig).toBe(true);
    expect(b.historyLines).toBe(3);
  });
});
