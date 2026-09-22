export type ArgKind = 'boolean' | 'string' | 'positional';

export type ArgSpec = {
  kind: ArgKind;
  alias?: string;
  description: string;
  required?: boolean;
  values?: string[];
  default?: string | boolean;
};

export type CompletionSource = 'project' | 'directory' | 'backup' | 'bundle' | 'shell' | 'none';

export type CommandSpec = {
  name: string;
  summary: string;
  positionals: { name: string; complete: CompletionSource; required: boolean }[];
  args: Record<string, ArgSpec>;
};

const MUTATING_ARGS: Record<string, ArgSpec> = {
  'dry-run': { kind: 'boolean', alias: 'n', description: '계획만 보여주고 아무것도 쓰지 않습니다' },
  yes: { kind: 'boolean', alias: 'y', description: '확인 프롬프트를 건너뜁니다' },
  force: { kind: 'boolean', alias: 'f', description: 'lock 과 상태 충돌을 경고로 낮춥니다' },
  'no-backup': { kind: 'boolean', description: '백업을 만들지 않습니다 (rollback 불가)' },
};

const COMMON_ARGS: Record<string, ArgSpec> = {
  json: { kind: 'boolean', description: '기계용 JSON 으로 출력합니다' },
  quiet: { kind: 'boolean', alias: 'q', description: '오류만 출력합니다' },
  'claude-home': { kind: 'string', description: '~/.claude 위치를 재정의합니다' },
};

export const COMMANDS: CommandSpec[] = [
  {
    name: 'mv',
    summary: '디렉터리를 옮기고 Claude 상태를 따라 옮깁니다',
    positionals: [
      { name: 'src', complete: 'project', required: true },
      { name: 'dst', complete: 'directory', required: true },
    ],
    args: {
      ...MUTATING_ARGS,
      ...COMMON_ARGS,
      'state-only': { kind: 'boolean', description: '디렉터리는 두고 상태만 옮깁니다' },
      'rewrite-prose': { kind: 'boolean', description: '대화 본문의 경로까지 바꿉니다' },
      'allow-ancestors': { kind: 'boolean', description: '상위에서 도는 세션을 허용합니다' },
      'skip-live': {
        kind: 'boolean',
        description: '살아 있는 세션의 트랜스크립트는 건드리지 않습니다',
      },
    },
  },
  {
    name: 'ls',
    summary: 'Claude 가 아는 프로젝트를 모두 보여줍니다',
    positionals: [],
    args: {
      ...COMMON_ARGS,
      orphans: { kind: 'boolean', description: '고아 상태만 보여줍니다' },
      sort: {
        kind: 'string',
        description: '정렬 기준',
        values: ['activity', 'size', 'path'],
        default: 'activity',
      },
    },
  },
  {
    name: 'info',
    summary: '한 프로젝트의 상태를 자세히 보여줍니다',
    positionals: [{ name: 'target', complete: 'project', required: false }],
    args: COMMON_ARGS,
  },
  {
    name: 'doctor',
    summary: '고아가 된 상태를 찾고 어디로 갔는지 추측합니다',
    positionals: [],
    args: COMMON_ARGS,
  },
  {
    name: 'rm',
    summary: '한 프로젝트의 Claude 상태를 지웁니다',
    positionals: [{ name: 'target', complete: 'project', required: false }],
    args: { ...MUTATING_ARGS, ...COMMON_ARGS },
  },
  {
    name: 'merge',
    summary: '두 프로젝트 디렉터리를 합칩니다',
    positionals: [
      { name: 'from', complete: 'project', required: true },
      { name: 'to', complete: 'project', required: true },
    ],
    args: { ...MUTATING_ARGS, ...COMMON_ARGS },
  },
  {
    name: 'backup',
    summary: '이동 없이 현재 상태의 스냅샷만 만듭니다',
    positionals: [{ name: 'target', complete: 'project', required: false }],
    args: COMMON_ARGS,
  },
  {
    name: 'rollback',
    summary: '백업 목록을 보거나 지정한 백업으로 되돌립니다',
    positionals: [{ name: 'id', complete: 'backup', required: false }],
    args: COMMON_ARGS,
  },
  {
    name: 'export',
    summary: '프로젝트 상태를 tarball 로 내보냅니다',
    positionals: [{ name: 'target', complete: 'project', required: false }],
    args: { ...COMMON_ARGS, out: { kind: 'string', alias: 'o', description: '출력 파일' } },
  },
  {
    name: 'import',
    summary: 'tarball 에서 상태를 들여옵니다',
    positionals: [{ name: 'file', complete: 'bundle', required: true }],
    args: {
      ...COMMON_ARGS,
      to: { kind: 'string', description: '들여오면서 이 경로로 이관합니다' },
    },
  },
  {
    name: 'completion',
    summary: '셸 자동완성 스크립트를 출력합니다',
    positionals: [{ name: 'shell', complete: 'shell', required: true }],
    args: {},
  },
];

export const COMMAND_NAMES = COMMANDS.map((c) => c.name);

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name);
}

const VALUE_FLAGS = new Set(
  COMMANDS.flatMap((command) =>
    Object.entries(command.args)
      .filter(([, arg]) => arg.kind === 'string')
      .flatMap(([name, arg]) => (arg.alias ? [`--${name}`, `-${arg.alias}`] : [`--${name}`])),
  ),
);

export function dispatch(argv: string[]): { command: string; rest: string[] } {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === '--') return { command: 'mv', rest: argv.slice(i + 1) };
    if (token === '__complete') return { command: '__complete', rest: argv.slice(i + 1) };

    if (token.startsWith('-')) {
      if (!token.includes('=') && VALUE_FLAGS.has(token)) i++;
      continue;
    }

    if (COMMAND_NAMES.includes(token)) {
      return { command: token, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] };
    }
    break;
  }

  return { command: 'mv', rest: argv };
}
