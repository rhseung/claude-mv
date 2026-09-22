import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { temporaryDirectory } from 'tempy';
import { describe, expect, it } from 'vitest';

import { createFakeClaudeHome } from './fixtures/claude-home.js';
import { records } from './fixtures/transcript.js';
import { runBackupOnly, runMerge, runRemove } from '../src/commands/manage.js';
import { runExport, runImport } from '../src/commands/transfer.js';
import { mangle } from '../src/core/mangle.js';
import { scan } from '../src/core/scan.js';

import type { AppContext } from '../src/shared/context.js';

function silentReporter() {
  const notes: string[] = [];
  const warnings: string[] = [];
  return {
    notes,
    warnings,
    reporter: {
      plan() {},
      confirm: async () => true,
      progress() {},
      applied() {},
      failed() {},
      locks() {},
      doctor() {},
      list() {},
      info() {},
      backups() {},
      note: (m: string) => notes.push(m),
      warn: (m: string) => warnings.push(m),
      close: async () => {},
    },
  };
}

async function context(spec: Parameters<typeof createFakeClaudeHome>[0]): Promise<AppContext> {
  const target = createFakeClaudeHome(spec);
  return {
    env: {
      claudeHome: target.home,
      configPath: target.configPath,
      projectsDir: target.projectsDir,
      historyPath: target.historyPath,
      sessionsDir: target.sessionsDir,
      plansDir: join(target.home, 'plans'),
      cacheRoot: target.cacheRoot,
      toolDir: join(target.home, '.claude-mv'),
      platform: process.platform,
    },
    policy: 'sensitive',
    platform: process.platform,
    probe: { exists: async () => false, startedAt: async () => null, self: 0 },
    index: await scan(target),
    exists: existsSync,
    listDirs: () => [],
  };
}

describe('rm', () => {
  it('디렉터리가 살아 있으면 거부한다', async () => {
    const alive = temporaryDirectory();
    const ctx = await context({
      projects: [{ path: alive, sessions: { s1: [records.user(alive)] } }],
    });
    const { reporter } = silentReporter();

    await expect(
      runRemove(ctx, reporter, {
        target: alive,
        home: '/home',
        version: '0',
        yes: true,
        force: false,
      }),
    ).rejects.toThrow(/아직 존재합니다/);
  });

  it('--force 면 상태를 지우고 config 키까지 들어낸다', async () => {
    const gone = join(temporaryDirectory(), 'gone');
    const keep = '/keep/me';
    const ctx = await context({
      projects: [{ path: gone, sessions: { s1: [records.user(gone)] } }],
      configProjects: [gone, keep],
    });
    const { reporter } = silentReporter();

    await runRemove(ctx, reporter, {
      target: gone,
      home: '/home',
      version: '0',
      yes: true,
      force: true,
    });

    expect(existsSync(join(ctx.env.projectsDir, mangle(gone)))).toBe(false);

    const config = JSON.parse(readFileSync(ctx.env.configPath, 'utf8'));
    expect(Object.keys(config.projects)).toEqual([keep]);
  });
});

describe('merge', () => {
  it('세션 파일을 옮기고 빈 디렉터리를 치운다', async () => {
    const a = '/w/a';
    const b = '/w/b';
    const ctx = await context({
      projects: [
        { path: a, sessions: { 'sess-a': [records.user(a)] } },
        { path: b, sessions: { 'sess-b': [records.user(b)] } },
      ],
    });
    const { reporter } = silentReporter();

    runMerge(ctx, reporter, { from: b, to: a, home: '/home', yes: true });

    expect(readdirSync(join(ctx.env.projectsDir, mangle(a))).sort()).toEqual([
      'sess-a.jsonl',
      'sess-b.jsonl',
    ]);
    expect(existsSync(join(ctx.env.projectsDir, mangle(b)))).toBe(false);
  });

  it('이름이 겹치면 덮지 않고 건너뛴다', async () => {
    const a = '/w/a';
    const b = '/w/b';
    const ctx = await context({
      projects: [
        { path: a, sessions: { same: [records.user(a)] } },
        { path: b, sessions: { same: [records.user(b)] } },
      ],
    });
    const { reporter, warnings } = silentReporter();

    runMerge(ctx, reporter, { from: b, to: a, home: '/home', yes: true });

    expect(warnings.join()).toContain('same.jsonl');
    expect(readFileSync(join(ctx.env.projectsDir, mangle(a), 'same.jsonl'), 'utf8')).toContain(a);
  });
});

describe('export / import', () => {
  it('내보낸 뒤 다른 홈으로 들여오면 기록이 그대로다', async () => {
    const path = '/w/proj';
    const source = await context({
      projects: [{ path, sessions: { s1: [records.user(path), records.user(path)] } }],
    });
    const { reporter } = silentReporter();

    const bundle = join(temporaryDirectory(), 'state.tgz');
    runExport(source, reporter, { target: path, out: bundle, home: '/home' });
    expect(existsSync(bundle)).toBe(true);

    const destination = await context({});
    const result = runImport(destination, reporter, { file: bundle, home: '/home' });

    expect(result.code).toBe('ok');
    const restored = join(destination.env.projectsDir, mangle(path), 's1.jsonl');
    expect(readFileSync(restored, 'utf8')).toContain(path);
  });

  it('--to 를 주면 이어서 이관할 경로를 알려준다', async () => {
    const path = '/w/proj';
    const source = await context({
      projects: [{ path, sessions: { s1: [records.user(path)] } }],
    });
    const { reporter } = silentReporter();

    const bundle = join(temporaryDirectory(), 'state.tgz');
    runExport(source, reporter, { target: path, out: bundle, home: '/home' });

    const destination = await context({});
    const result = runImport(destination, reporter, {
      file: bundle,
      to: '/elsewhere/proj',
      home: '/home',
    });

    expect(result.migrateFrom).toBe(path);
    expect(result.migrateTo).toBe('/elsewhere/proj');
  });

  it('이미 있는 상태는 덮어쓰지 않는다', async () => {
    const path = '/w/proj';
    const source = await context({
      projects: [{ path, sessions: { s1: [records.user(path)] } }],
    });
    const { reporter } = silentReporter();

    const bundle = join(temporaryDirectory(), 'state.tgz');
    runExport(source, reporter, { target: path, out: bundle, home: '/home' });

    expect(() => runImport(source, reporter, { file: bundle, home: '/home' })).toThrow(
      /덮어쓰지 않습니다/,
    );
  });

  it('claude-mv 번들이 아니면 거부한다', async () => {
    const ctx = await context({});
    const { reporter } = silentReporter();

    const fake = join(temporaryDirectory(), 'not-a-bundle.tgz');
    mkdirSync(join(temporaryDirectory(), 'x'), { recursive: true });
    writeFileSync(fake, 'not a tarball');

    expect(() => runImport(ctx, reporter, { file: fake, home: '/home' })).toThrow();
  });
});

describe('backup', () => {
  it('이동 없이 스냅샷만 만든다', async () => {
    const path = '/w/proj';
    const ctx = await context({
      projects: [{ path, sessions: { s1: [records.user(path)] } }],
    });
    const { reporter, notes } = silentReporter();

    runBackupOnly(ctx, reporter, { target: path, home: '/home', version: '0' });

    expect(notes.join()).toMatch(/백업 \d/);
    expect(existsSync(join(ctx.env.projectsDir, mangle(path), 's1.jsonl'))).toBe(true);
  });
});
