/** 종료 코드. --dry-run 이 10 으로 끝나는 게 의외라 help 와 README 에 따로 적는다. */
export const ExitCode = {
  ok: 0,
  internal: 1,
  usage: 2,
  planned: 10,
  orphans: 11,
  nothingToDo: 12,
  locked: 20,
  conflict: 21,
  precondition: 22,
  failedRolledBack: 30,
  failedDirty: 31,
  io: 40,
  interrupted: 130,
} as const;

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
