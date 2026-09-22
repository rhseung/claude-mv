import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { mangle } from '../core/mangle.js';

const BUDGET_MS = 60;
const THROTTLE_MS = 12 * 60 * 60 * 1000;

type HookInput = { cwd?: string };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function claudeHome(): string {
  return (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')).normalize('NFC');
}

function configPath(home: string): string {
  const preferred = join(home, '.config.json');
  if (existsSync(preferred)) return preferred;
  return join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');
}

function knownProjects(path: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { projects?: Record<string, unknown> };
    return Object.keys(parsed.projects ?? {});
  } catch {
    return [];
  }
}

function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

function dirname(path: string): string {
  const parts = path.split(/[/\\]/);
  parts.pop();
  return parts.join('/') || '/';
}

function pickCandidate(known: string[], cwd: string): string | null {
  const scored = known
    .map((path) => {
      let score = 0;
      if (dirname(path) === dirname(cwd)) score += 2;
      if (basename(path) === basename(cwd)) score += 2;
      return { path, score };
    })
    .filter((c) => c.score >= 2)
    .sort((a, b) => b.score - a.score);

  const [best, second] = scored;
  if (!best) return null;
  if (second && second.score === best.score) return null;
  return best.path;
}

function warnedRecently(cwd: string): boolean {
  const stamp = join(tmpdir(), `claude-mv-warned-${Buffer.from(cwd).toString('base64url')}`);
  try {
    if (Date.now() - statSync(stamp).mtimeMs < THROTTLE_MS) return true;
    utimesSync(stamp, new Date(), new Date());
    return false;
  } catch {
    try {
      mkdirSync(tmpdir(), { recursive: true });
      writeFileSync(stamp, '');
    } catch {}
    return false;
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const input = JSON.parse(await readStdin()) as HookInput;
  const cwd = input.cwd;
  if (!cwd) return;

  const home = claudeHome();
  const projectsDir = join(home, 'projects');

  if (existsSync(join(projectsDir, mangle(cwd)))) return;
  if (warnedRecently(cwd)) return;

  const candidate = pickCandidate(knownProjects(configPath(home)), cwd);
  if (!candidate) return;
  if (existsSync(candidate)) return;
  if (!existsSync(join(projectsDir, mangle(candidate)))) return;
  if (Date.now() - startedAt > BUDGET_MS) return;

  process.stdout.write(
    JSON.stringify({
      systemMessage: [
        'claude-mv: 이 디렉터리에는 Claude 프로젝트 기록이 없습니다.',
        `  ${candidate} 의 기록이 남아 있고, 그 경로는 지금 없습니다.`,
        `  옮긴 것이라면:  npx @rhseung/claude-mv --state-only "${candidate}" "${cwd}"`,
        '  먼저 확인하려면:  npx @rhseung/claude-mv doctor',
      ].join('\n'),
    }),
  );
}

main().catch(() => {});
