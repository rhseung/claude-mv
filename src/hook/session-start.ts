import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { mangle } from '../core/mangle.js';

/**
 * SessionStart 훅.
 *
 * 하는 일은 경고 하나뿐이다. 절대 스스로 옮기지 않는다 - 잘못 짚었을 때 사용자가
 * 멀쩡한 다른 프로젝트의 기록을 잃게 되고, 그건 훅이 감당할 수 있는 위험이 아니다.
 *
 * 세션이 열릴 때마다 도는 자리라 빨라야 한다. 정상 경로는 existsSync 한 번으로 끝난다.
 */
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

/** ~/.claude.json 의 projects 키는 진짜 절대 경로다. mangled 이름은 되돌릴 수 없다. */
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

/**
 * 어느 경로에서 옮겨왔는지 짐작한다.
 *
 * 동점이면 아무 말도 하지 않는다. 틀린 추측을 따라가면 사용자가 멀쩡한 다른
 * 프로젝트의 상태를 덮어쓰게 되므로, 경고를 못 하는 쪽이 낫다.
 */
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
    } catch {
      // 스탬프를 못 써도 경고 자체는 해야 한다.
    }
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

  // 정상 경로는 여기서 끝난다. 옮기지 않은 프로젝트는 syscall 한 번만 낸다.
  if (existsSync(join(projectsDir, mangle(cwd)))) return;
  if (warnedRecently(cwd)) return;

  const candidate = pickCandidate(knownProjects(configPath(home)), cwd);
  if (!candidate) return;
  // 원본이 아직 살아 있으면 이름만 닮은 남의 프로젝트다.
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

// 훅이 실패해도 세션은 떠야 한다. 여기서 던지면 Claude Code 가 세션 시작에 오류를
// 띄우는데, 그건 경고를 못 하는 것보다 훨씬 나쁘다.
main().catch(() => {});
