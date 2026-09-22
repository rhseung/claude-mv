import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 실제 ~/.claude 에서 확인한 레코드 형태를 그대로 옮긴 fixture 빌더.
 * 여기 없는 모양이 실전에 나오면 그건 fixture 를 고쳐야 한다는 신호다.
 */
export const records = {
  /** 가장 흔한 형태. cwd 하나. */
  user: (cwd: string) => ({
    type: 'user',
    cwd,
    uuid: 'u1',
    message: { role: 'user', content: [] },
  }),

  /** 레코드의 40% 가량은 경로 필드가 아예 없다. */
  pathless: () => ({ type: 'cost-state', totalCostUSD: 1.5 }),

  /** 툴 호출당 하나씩 붙는 사이드카. 키가 tool_use id 라 미리 알 수 없다. */
  withWire: (cwd: string, toolId = 'toolu_01abc') => ({
    type: 'assistant',
    cwd,
    wireIngestContext: { [toolId]: { cwd } },
    wireToolInputs: { [toolId]: { command: `ls ${cwd}` } },
  }),

  /** 스냅샷은 추가 작업 디렉터리 배열을 들고 있다. */
  withSnapshot: (cwd: string, extra: string[] = []) => ({
    type: 'attachment',
    cwd,
    attachment: {
      snapshot: { workingDirectory: cwd, additionalWorkingDirectories: extra },
      path: '.zshrc', // 상대 경로가 섞여 들어온다
    },
  }),

  /** 플랜 소유권을 알려주는 구조 필드. */
  withPlan: (cwd: string, planPath: string) => ({
    type: 'user',
    cwd,
    attachment: { planFilePath: planPath },
    message: { role: 'user', content: [{ type: 'tool_use', input: { planFilePath: planPath } }] },
  }),

  /** 서술 필드에만 경로가 있는 레코드. 기본 설정에서는 건드리면 안 된다. */
  proseOnly: (path: string) => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `cd ${path} 했습니다` }] },
  }),
};

export type FixtureOptions = {
  /** 마지막 줄을 잘라서 라이브 세션이 쓰는 중인 상황을 만든다. */
  truncateLast?: boolean;
  /** CRLF 로 쓴다. */
  crlf?: boolean;
  /** 줄바꿈 없이 끝낸다. */
  noFinalNewline?: boolean;
};

export function writeTranscript(
  lines: unknown[],
  opts: FixtureOptions = {},
): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'claude-mv-fx-'));
  const file = join(dir, '01639d17-dc87-492a-9469-f84c6c2b6cc8.jsonl');
  const eol = opts.crlf ? '\r\n' : '\n';

  let body = lines.map((l) => JSON.stringify(l)).join(eol);
  if (opts.truncateLast) body = `${body}${eol}{"type":"user","cwd":"/a/b","unterm`;
  if (!opts.noFinalNewline && !opts.truncateLast) body += eol;

  writeFileSync(file, body);
  return { dir, file };
}
