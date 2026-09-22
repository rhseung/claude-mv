import { COMMANDS, findCommand, type CompletionSource } from './commands.js';

export type Candidate = { value: string; description?: string };

export type CompleteSources = {
  projects: () => Candidate[];
  backups: () => Candidate[];
  directories: (prefix: string) => Candidate[];
  bundles: (prefix: string) => Candidate[];
};

export function complete(argv: string[], sources: CompleteSources): Candidate[] {
  const [commandName, ...rest] = argv;

  if (rest.length === 0 && !COMMANDS.some((c) => c.name === commandName)) {
    return COMMANDS.filter((c) => c.name.startsWith(commandName ?? '')).map((c) => ({
      value: c.name,
      description: c.summary,
    }));
  }

  const spec = findCommand(commandName ?? '') ?? findCommand('mv')!;
  const current = rest.at(-1) ?? '';

  if (current.startsWith('-')) {
    const [flagName, inlineValue] = current.split('=');
    const arg = spec.args[flagName?.replace(/^--?/, '') ?? ''];

    if (arg?.values && inlineValue !== undefined) {
      return arg.values
        .filter((v) => v.startsWith(inlineValue))
        .map((v) => ({ value: `${flagName}=${v}` }));
    }

    return Object.entries(spec.args)
      .map(([name, meta]) => ({ value: `--${name}`, description: meta.description }))
      .filter((c) => c.value.startsWith(current));
  }

  const consumed = rest.filter((token) => !token.startsWith('-'));
  const index = Math.max(0, consumed.length - 1);
  const positional = spec.positionals[index];

  return filterByPrefix(candidatesFor(positional?.complete ?? 'none', current, sources), current);
}

function candidatesFor(
  source: CompletionSource,
  prefix: string,
  sources: CompleteSources,
): Candidate[] {
  switch (source) {
    case 'project':
      return sources.projects();
    case 'backup':
      return sources.backups();
    case 'directory':
      return sources.directories(prefix);
    case 'bundle':
      return sources.bundles(prefix);
    case 'shell':
      return [{ value: 'zsh' }, { value: 'bash' }, { value: 'fish' }];
    case 'none':
      return [];
  }
}

function filterByPrefix(candidates: Candidate[], prefix: string): Candidate[] {
  return prefix ? candidates.filter((c) => c.value.startsWith(prefix)) : candidates;
}

export function formatCandidates(candidates: Candidate[]): string {
  return candidates
    .map((c) => (c.description ? `${c.value}\t${c.description}` : c.value))
    .join('\n');
}
