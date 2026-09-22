import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** 디렉터리 트리의 경로별 내용 해시. 되돌리기가 정말로 원상복구인지 보는 데 쓴다. */
export function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      out.set(relative(root, full), createHash('sha256').update(readFileSync(full)).digest('hex'));
    }
  };

  walk(root);
  return out;
}

export function diff(before: Map<string, string>, after: Map<string, string>): string[] {
  const problems: string[] = [];
  for (const [path, hash] of before) {
    if (!after.has(path)) problems.push(`사라짐: ${path}`);
    else if (after.get(path) !== hash) problems.push(`내용 다름: ${path}`);
  }
  for (const path of after.keys()) {
    if (!before.has(path)) problems.push(`새로 생김: ${path}`);
  }
  return problems;
}

export function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
