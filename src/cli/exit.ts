const EXITS = {
  ok: [0, '성공'],
  internal: [1, '예기치 못한 오류'],
  usage: [2, '사용법 오류'],
  planned: [10, '계획 생성 완료. 실패가 아님'],
  orphans: [11, '연결이 끊긴 상태 발견'],
  nothingToDo: [12, '이관 대상 없음'],
  locked: [20, '옛 경로에서 세션 실행 중'],
  conflict: [21, '대상 경로에 상태가 이미 존재'],
  precondition: [22, '전제 조건 위반'],
  failedRolledBack: [30, '실패 후 전체 복구 완료'],
  failedDirty: [31, '실패 후 복구도 실패. 수동 복구 필요'],
  io: [40, '파일시스템 오류'],
  interrupted: [130, '사용자 중단'],
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
