import prettyBytes from 'pretty-bytes';
import prettyMs from 'pretty-ms';
import stringWidth from 'string-width';

import type { PlanStep } from '../core/plan.js';

/** 단계마다 다른 단위를 억지로 통일하지 않는다. 솔직한 단위가 더 읽기 쉽다. */
export function describeStep(step: PlanStep): { label: string; action: string; detail: string } {
  switch (step.kind) {
    case 'move-project-dir':
      return { label: 'project dir', action: 'rename', detail: `${step.files} files` };
    case 'rewrite-transcript':
      return {
        label: step.movesWithDir ? 'transcript' : 'transcript (제자리)',
        action: 'rewrite',
        detail: `${step.affected}/${step.total} 줄`,
      };
    case 'edit-config':
      return {
        label: 'claude.json',
        action: step.renameKey ? 'rekey' : 'edit',
        detail: step.githubRepos.length ? `+ ${step.githubRepos.length} repo` : '1 key',
      };
    case 'rewrite-history':
      return { label: 'history', action: 'rewrite', detail: `${step.affected} 줄` };
    case 'move-cache-dir':
      return { label: 'mcp logs', action: 'rename', detail: '' };
    case 'rewrite-plan':
      return { label: 'plan', action: 'rewrite', detail: basename(step.file) };
    case 'move-directory':
      return { label: 'working tree', action: 'move', detail: '' };
    case 'repair-worktrees':
      return { label: 'worktrees', action: 'repair', detail: '' };
  }
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

export function bytes(n: number): string {
  return prettyBytes(n);
}

export function duration(ms: number): string {
  return prettyMs(ms, { compact: true });
}

export function ago(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return '방금';
  return `${prettyMs(delta, { compact: true })} 전`;
}

/** 한글은 터미널에서 두 칸을 먹는다. 문자 수로 패딩하면 표가 어긋난다. */
export function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - stringWidth(text)));
}

export function table(rows: string[][], gap = 2): string[] {
  const widths =
    rows[0]?.map((_, i) => Math.max(...rows.map((r) => stringWidth(r[i] ?? '')))) ?? [];
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : pad(cell, widths[i]! + gap)))
      .join('')
      .trimEnd(),
  );
}

export function shortenPath(path: string, home: string): string {
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
