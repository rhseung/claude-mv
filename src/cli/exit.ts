const EXITS = {
  ok: [0, '성공'],
  internal: [1, '예기치 못한 오류'],
  usage: [2, '사용법 오류'],
  planned: [10, '--dry-run 이 계획을 만들었다'],
  orphans: [11, '고아 상태를 찾았다'],
  nothingToDo: [12, '옮길 것이 없다'],
  locked: [20, '옛 경로에서 세션이 돌고 있다'],
  conflict: [21, '대상 쪽에 이미 상태가 있다'],
  precondition: [22, '전제 조건 위반'],
  failedRolledBack: [30, '실패했고 전부 되돌렸다'],
  failedDirty: [31, '실패했고 되돌리기도 실패했다'],
  io: [40, '파일시스템 오류'],
  interrupted: [130, '중단됨'],
} as const satisfies Record<string, readonly [number, string]>;

export const ExitCode = Object.fromEntries(
  Object.entries(EXITS).map(([name, [code]]) => [name, code]),
) as { [K in keyof typeof EXITS]: (typeof EXITS)[K][0] };

export const exitCodeTable: readonly (readonly [number, string])[] = Object.values(EXITS);

export type ExitCodeName = keyof typeof ExitCode;

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: ExitCodeName = 'usage',
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}
