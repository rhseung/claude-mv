import { CliError } from './exit.js';

import type { CommandSpec } from './commands.js';

export type ParsedArgs = {
  positionals: string[];
  flags: Record<string, string | boolean>;
};

export function parseArgs(spec: CommandSpec, argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  const byAlias = new Map<string, string>();
  for (const [name, arg] of Object.entries(spec.args)) {
    if (arg.alias) byAlias.set(arg.alias, name);
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }

    const isLong = token.startsWith('--');
    const body = isLong ? token.slice(2) : token.slice(1);
    const [rawName, inlineValue] = splitOnce(body, '=');

    const name = isLong ? rawName : (byAlias.get(rawName) ?? rawName);

    const arg = spec.args[name];
    if (!arg && isLong && name.startsWith('no-')) {
      const positive = name.slice(3);
      if (spec.args[positive]?.kind === 'boolean') {
        flags[positive] = false;
        continue;
      }
    }

    if (!arg) throw new CliError(`모르는 옵션입니다: ${token}`, 'usage');

    if (arg.kind === 'boolean') {
      flags[name] = inlineValue === undefined ? true : inlineValue !== 'false';
      continue;
    }

    const value = inlineValue ?? argv[++i];
    if (value === undefined) throw new CliError(`${token} 에 값이 필요합니다.`, 'usage');

    if (arg.values && !arg.values.includes(value)) {
      throw new CliError(`${token} 는 ${arg.values.join(' | ')} 중 하나여야 합니다.`, 'usage');
    }
    flags[name] = value;
  }

  for (const [name, arg] of Object.entries(spec.args)) {
    if (arg.default !== undefined && flags[name] === undefined) flags[name] = arg.default;
  }

  return { positionals, flags };
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const index = value.indexOf(separator);
  return index === -1 ? [value, undefined] : [value.slice(0, index), value.slice(index + 1)];
}

export function requirePositionals(spec: CommandSpec, parsed: ParsedArgs): string[] {
  const required = spec.positionals.filter((p) => p.required);
  if (parsed.positionals.length < required.length) {
    throw new CliError(
      `${spec.name} 에는 ${required.map((p) => `<${p.name}>`).join(' ')} 가 필요합니다.`,
      'usage',
    );
  }
  return parsed.positionals;
}

export const bool = (parsed: ParsedArgs, name: string): boolean => parsed.flags[name] === true;
export const str = (parsed: ParsedArgs, name: string): string | undefined =>
  typeof parsed.flags[name] === 'string' ? (parsed.flags[name] as string) : undefined;
