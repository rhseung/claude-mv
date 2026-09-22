import { execa } from 'execa';

import type { Candidate } from './complete.js';

export type PickerMode = 'fzf' | 'ink' | 'none';

export function resolvePickerMode(env: {
  override?: string;
  isTTY: boolean;
  hasFzf: boolean;
}): PickerMode {
  if (!env.isTTY) return 'none';
  if (env.override === 'none') return 'none';
  if (env.override === 'ink') return 'ink';
  if (env.override === 'fzf') return 'fzf';
  return env.hasFzf ? 'fzf' : 'ink';
}

export async function hasFzf(): Promise<boolean> {
  try {
    await execa('fzf', ['--version']);
    return true;
  } catch {
    return false;
  }
}

export async function pickWithFzf(
  candidates: Candidate[],
  opts: { prompt: string; preview?: string },
): Promise<string | null> {
  if (candidates.length === 0) return null;

  const args = ['--height=40%', '--reverse', `--prompt=${opts.prompt} `, '--with-nth=1..'];
  if (opts.preview) args.push('--preview', opts.preview, '--preview-window=right,60%');

  try {
    const { stdout } = await execa('fzf', args, {
      input: candidates
        .map((c) => (c.description ? `${c.value}\t${c.description}` : c.value))
        .join('\n'),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
    });
    const picked = stdout.trim().split('\t')[0];
    return picked || null;
  } catch {
    return null;
  }
}
