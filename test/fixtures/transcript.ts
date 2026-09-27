import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const records = {
  user: (cwd: string) => ({
    type: 'user',
    cwd,
    uuid: 'u1',
    message: { role: 'user', content: [] },
  }),

  pathless: () => ({ type: 'cost-state', totalCostUSD: 1.5 }),

  withWire: (cwd: string, toolId = 'toolu_01abc') => ({
    type: 'assistant',
    cwd,
    wireIngestContext: { [toolId]: { cwd } },
    wireToolInputs: { [toolId]: { command: `ls ${cwd}` } },
  }),

  withSnapshot: (cwd: string, extra: string[] = []) => ({
    type: 'attachment',
    cwd,
    attachment: {
      snapshot: { workingDirectory: cwd, additionalWorkingDirectories: extra },
      path: '.zshrc',
    },
  }),

  withPlan: (cwd: string, planPath: string) => ({
    type: 'user',
    cwd,
    attachment: { planFilePath: planPath },
    message: { role: 'user', content: [{ type: 'tool_use', input: { planFilePath: planPath } }] },
  }),

  withClassifier: (cwd: string, root: string | null) => ({
    type: 'user',
    cwd,
    serverClassifierContext: {
      request: 'r1',
      context: { git_state: { cwd, root, branch: null, error: 'pending' } },
    },
  }),

  withFileHistory: (root: string) => ({
    type: 'file-history-snapshot',
    messageId: 'm1',
    snapshot: {
      messageId: 'm1',
      trackedFileBackups: {
        'src/a.ts': { backupFileName: 'aa@v1', version: 1, realParentDir: `${root}/src` },
        [`${root}/b.ts`]: { backupFileName: 'bb@v1', version: 1, realParentDir: root },
        'c.ts': { backupFileName: 'cc@v1', version: 1 },
      },
    },
  }),

  withFileHistoryDelta: (root: string) => ({
    type: 'file-history-delta',
    trackingPath: 'src/a.ts',
    backup: { backupFileName: null, version: 1, realParentDir: `${root}/src` },
  }),

  withReadResult: (path: string) => ({
    type: 'user',
    toolUseResult: { type: 'text', file: { filePath: path, content: '' } },
  }),

  proseOnly: (path: string) => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `cd ${path} 했습니다` }] },
  }),
};

export type FixtureOptions = {
  truncateLast?: boolean;
  crlf?: boolean;
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
