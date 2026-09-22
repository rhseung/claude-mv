import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import pkg from '../package.json' with { type: 'json' };
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

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${pkg.version}\n`);
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
  if (!spec) throw new CliError(`알 수 없는 명령입니다: ${command}`, 'usage');

  const parsed = parseArgs(spec, rest);

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
    throw new CliError(
      '--json으로 실행할 때는 --yes가 필요합니다. 확인을 물을 수 없기 때문입니다.',
      'usage',
    );
  }

  const reporter: Reporter =
    mode === 'json'
      ? new JsonReporter(process.stdout, process.stderr, pkg.version)
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
        skipLive: bool(parsed, 'skip-live'),
        home,
        version: pkg.version,
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
        version: pkg.version,
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
        version: pkg.version,
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
        skipLive: false,
        home,
        version: pkg.version,
      });
    }

    default:
      throw new CliError(`아직 구현되지 않았습니다: ${command}`, 'internal');
  }
}

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
    throw new CliError(`claude-mv ${command} <프로젝트>가 필요합니다.`, 'usage');
  }

  const candidates = projectCandidates(ctx);
  const picked =
    picker === 'fzf'
      ? await pickWithFzf(candidates, {
          prompt: `${command}>`,
          preview: 'claude-mv info {1} 2>/dev/null',
        })
      : null;

  if (!picked) throw new CliError('대상을 선택하지 않았습니다.', 'usage');
  return picked;
}

function projectCandidates(ctx: AppContext): Candidate[] {
  return ctx.index.projects.map((p) => ({
    value: p.primaryCwd ?? p.dirName,
    description: p.health === 'healthy' ? undefined : p.health,
  }));
}

async function runComplete(words: string[]): Promise<number> {
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
  } catch {}
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
