import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { findCommand, dispatch } from './cli/commands.js';
import { complete, formatCandidates, type Candidate } from './cli/complete.js';
import { completionScript, type Shell } from './cli/completion/index.js';
import { CliError, ExitCode, type ExitCodeName } from './cli/exit.js';
import { helpText } from './cli/help.js';
import { bool, parseArgs, requirePositionals, str, type ParsedArgs } from './cli/parse.js';
import { hasFzf, pickWithFzf, resolvePickerMode } from './cli/picker.js';
import { runBackupOnly, runBackups, runMerge, runRemove, runRollback } from './commands/manage.js';
import { runMove } from './commands/mv.js';
import { runDoctor, runInfo, runList } from './commands/query.js';
import { runExport, runImport } from './commands/transfer.js';
import { backupRoot } from './core/apply.js';
import { listBackups } from './core/backup.js';
import { JsonReporter } from './render/json/reporter.js';
import { PlainReporter } from './render/plain/reporter.js';
import { resolveRenderMode, type Reporter } from './render/reporter.js';
import { createContext, type AppContext } from './shared/context.js';
import { readCliEnv, type CliEnv } from './shared/env.js';

const VERSION = '0.1.0';

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    return ExitCode.ok;
  }

  const { command, rest } = dispatch(argv);

  if (command === '__complete') return await runComplete(rest);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(helpText());
    return ExitCode.ok;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(helpText(command));
    return ExitCode.ok;
  }

  const spec = findCommand(command);
  if (!spec) throw new CliError(`모르는 명령입니다: ${command}`, 'usage');

  const parsed = parseArgs(spec, rest);

  // completion 은 상태를 읽을 필요가 없다. 셸 시작마다 도는 자리라 빨라야 한다.
  if (command === 'completion') {
    const [shell] = requirePositionals(spec, parsed);
    if (!['zsh', 'bash', 'fish'].includes(shell!)) {
      throw new CliError('zsh, bash, fish 중 하나여야 합니다.', 'usage');
    }
    process.stdout.write(completionScript(shell as Shell));
    return ExitCode.ok;
  }

  const cliEnv = readCliEnv();
  const ctx = await createContext({ claudeHome: str(parsed, 'claude-home') });
  const mode = resolveRenderMode({
    json: bool(parsed, 'json'),
    quiet: bool(parsed, 'quiet'),
    isTTY: cliEnv.isStdoutTTY,
    ci: cliEnv.ci,
    term: cliEnv.term,
  });

  if (mode === 'json' && isMutating(command) && !bool(parsed, 'yes')) {
    throw new CliError('--json 으로 실행할 때는 --yes 가 필요합니다. 물어볼 수 없습니다.', 'usage');
  }

  // ink 는 여기서만, 그것도 동적으로 불러온다. --json 과 비TTY 경로가 React 와
  // 터미널 드라이버를 끌어오면 파이프 출력이 더러워지고 시작이 그만큼 느려진다.
  const reporter: Reporter =
    mode === 'json'
      ? new JsonReporter(process.stdout, process.stderr, VERSION)
      : mode === 'ink'
        ? (await import('./render/ink/reporter.js')).createInkReporter()
        : new PlainReporter();

  try {
    return ExitCode[await run(command, ctx, reporter, parsed, mode, cliEnv)];
  } finally {
    await reporter.close();
  }
}

function isMutating(command: string): boolean {
  return ['mv', 'rm', 'merge', 'import', 'rollback'].includes(command);
}

async function run(
  command: string,
  ctx: AppContext,
  reporter: Reporter,
  parsed: ParsedArgs,
  mode: string,
  cliEnv: CliEnv,
): Promise<ExitCodeName> {
  const home = homedir();
  const spec = findCommand(command)!;

  switch (command) {
    case 'mv': {
      const [src, dst] = requirePositionals(spec, parsed);
      return await runMove(ctx, reporter, {
        src: src!,
        dst: dst!,
        stateOnly: bool(parsed, 'state-only'),
        rewriteProse: bool(parsed, 'rewrite-prose'),
        dryRun: bool(parsed, 'dry-run'),
        yes: bool(parsed, 'yes'),
        force: bool(parsed, 'force'),
        noBackup: bool(parsed, 'no-backup'),
        allowAncestors: bool(parsed, 'allow-ancestors'),
        home,
        version: VERSION,
      });
    }

    case 'ls':
      return runList(ctx, reporter, {
        orphansOnly: bool(parsed, 'orphans'),
        sort: (str(parsed, 'sort') ?? 'activity') as 'activity' | 'size' | 'path',
      });

    case 'info':
      return runInfo(ctx, reporter, {
        target: await needTarget(ctx, parsed, mode, 'info', cliEnv),
        home,
      });

    case 'doctor':
      return runDoctor(ctx, reporter);

    case 'rm':
      return await runRemove(ctx, reporter, {
        target: await needTarget(ctx, parsed, mode, 'rm', cliEnv),
        home,
        version: VERSION,
        yes: bool(parsed, 'yes'),
        force: bool(parsed, 'force'),
      });

    case 'merge': {
      const [from, to] = requirePositionals(spec, parsed);
      return runMerge(ctx, reporter, { from: from!, to: to!, home, yes: bool(parsed, 'yes') });
    }

    case 'backup':
      return runBackupOnly(ctx, reporter, {
        target: await needTarget(ctx, parsed, mode, 'backup', cliEnv),
        home,
        version: VERSION,
      });

    case 'rollback': {
      const [id] = parsed.positionals;
      if (!id) return runBackups(ctx, reporter);
      return runRollback(ctx, reporter, { id });
    }

    case 'export':
      return runExport(ctx, reporter, {
        target: await needTarget(ctx, parsed, mode, 'export', cliEnv),
        out: str(parsed, 'out'),
        home,
      });

    case 'import': {
      const [file] = requirePositionals(spec, parsed);
      const result = runImport(ctx, reporter, { file: file!, to: str(parsed, 'to'), home });
      if (!result.migrateFrom || !result.migrateTo) return result.code;

      // 머신이 바뀌면 홈 경로도 바뀌므로 푸는 것만으로는 끝나지 않는다. mv 엔진을 그대로 탄다.
      const fresh = await createContext({ claudeHome: str(parsed, 'claude-home') });
      return await runMove(fresh, reporter, {
        src: result.migrateFrom,
        dst: result.migrateTo,
        stateOnly: true,
        rewriteProse: false,
        dryRun: false,
        yes: true,
        force: false,
        noBackup: false,
        allowAncestors: false,
        home,
        version: VERSION,
      });
    }

    default:
      throw new CliError(`아직 구현되지 않았습니다: ${command}`, 'internal');
  }
}

/** 인자를 생략했으면 목록에서 고르게 한다. 고를 수 없는 환경이면 사용법 오류다. */
async function needTarget(
  ctx: AppContext,
  parsed: ParsedArgs,
  mode: string,
  command: string,
  cliEnv: CliEnv,
): Promise<string> {
  const [given] = parsed.positionals;
  if (given) return given;

  const picker = resolvePickerMode({
    override: cliEnv.picker,
    isTTY: cliEnv.isStdinTTY && mode !== 'json',
    hasFzf: await hasFzf(),
  });

  if (picker === 'none') {
    throw new CliError(`claude-mv ${command} <프로젝트> 가 필요합니다.`, 'usage');
  }

  const candidates = projectCandidates(ctx);
  const picked =
    picker === 'fzf'
      ? await pickWithFzf(candidates, {
          prompt: `${command}>`,
          preview: 'claude-mv info {1} 2>/dev/null',
        })
      : null;

  if (!picked) throw new CliError('고르지 않았습니다.', 'usage');
  return picked;
}

function projectCandidates(ctx: AppContext): Candidate[] {
  return ctx.index.projects.map((p) => ({
    value: p.primaryCwd ?? p.dirName,
    description: p.health === 'healthy' ? undefined : p.health,
  }));
}

async function runComplete(words: string[]): Promise<number> {
  // 자동완성은 셸이 TAB 마다 부른다. 실패해도 조용히 끝내야 입력이 막히지 않는다.
  try {
    const ctx = await createContext();
    const root = backupRoot(ctx.env.toolDir);

    process.stdout.write(
      `${formatCandidates(
        complete(words, {
          projects: () => projectCandidates(ctx),
          backups: () => listBackups(root).map((b) => ({ value: b.backupId, description: b.dst })),
          directories: (prefix) => directoryCandidates(prefix),
          bundles: (prefix) => fileCandidates(prefix, '.tgz'),
        }),
      )}\n`,
    );
  } catch {
    // 후보를 못 주는 것과 셸을 멈추는 것은 전혀 다른 일이다.
  }
  return ExitCode.ok;
}

function directoryCandidates(prefix: string): Candidate[] {
  const base = prefix.endsWith('/') ? prefix : join(prefix, '..');
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ value: join(base, e.name) }));
  } catch {
    return [];
  }
}

function fileCandidates(prefix: string, suffix: string): Candidate[] {
  const base = prefix.includes('/') ? join(prefix, '..') : '.';
  try {
    return readdirSync(base)
      .filter((name) => name.endsWith(suffix))
      .map((name) => ({ value: join(base, name) }))
      .filter((c) => existsSync(c.value));
  } catch {
    return [];
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
      if (error.hint) process.stderr.write(`${error.hint}\n`);
      process.exit(ExitCode[error.code]);
    }
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    process.exit(ExitCode.internal);
  });
