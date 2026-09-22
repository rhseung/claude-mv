import { COMMANDS, findCommand, type CompletionSource } from './commands.js';

export type Candidate = { value: string; description?: string };

export type CompleteSources = {
  projects: () => Candidate[];
  backups: () => Candidate[];
  directories: (prefix: string) => Candidate[];
  bundles: (prefix: string) => Candidate[];
};

/**
 * 셸이 되물어서 후보를 받아 가는 자리.
 *
 * 인자가 경로라서 일반 파일 완성은 거의 쓸모가 없다. 정작 필요한 건
 * "Claude 가 아는 프로젝트" 라서, 그건 이 프로세스만 안다.
 */
export function complete(argv: string[], sources: CompleteSources): Candidate[] {
  const [commandName, ...rest] = argv;

  // 첫 낱말 자리면 명령 이름을 준다.
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

    // --sort= 처럼 닫힌 값 집합이면 그 값들을 준다.
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

/** 셸이 읽는 형식: 한 줄에 "값<TAB>설명". */
export function formatCandidates(candidates: Candidate[]): string {
  return candidates
    .map((c) => (c.description ? `${c.value}\t${c.description}` : c.value))
    .join('\n');
}
