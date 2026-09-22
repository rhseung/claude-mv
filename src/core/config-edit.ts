import { parseTree, type Node } from 'jsonc-parser';

import { reparent, type CasePolicy } from './paths.js';

export type ConfigEdit = { offset: number; length: number; replacement: string };

function findProperty(node: Node | undefined, key: string): Node | undefined {
  if (node?.type !== 'object') return undefined;
  return node.children?.find((child) => child.children?.[0]?.value === key);
}

/**
 * `~/.claude.json` 에서 바꿀 **바이트 구간**만 계산한다.
 *
 * 절대 parse -> 수정 -> stringify 를 하면 안 된다. 이 파일에는 OAuth 자격증명과
 * 우리가 모르는 키가 잔뜩 들어 있고, 통째로 재직렬화하면 그 전부를 우리 포맷으로
 * 다시 쓰게 된다. 실수 하나가 사용자를 재로그인시킨다.
 * 그래서 키 문자열이 놓인 자리만 정확히 찾아서 그 자리만 갈아끼운다.
 */
export function planConfigEdits(
  text: string,
  opts: { src: string; dst: string; policy: CasePolicy; platform: NodeJS.Platform },
): ConfigEdit[] {
  const root = parseTree(text);
  if (!root) return [];

  const edits: ConfigEdit[] = [];

  const projects = findProperty(root, 'projects');
  const projectsValue = projects?.children?.[1];
  if (projectsValue?.type === 'object') {
    for (const property of projectsValue.children ?? []) {
      const keyNode = property.children?.[0];
      if (typeof keyNode?.value !== 'string') continue;

      const next = reparent(keyNode.value, opts.src, opts.dst, opts.policy, opts.platform);
      if (next === undefined) continue;

      edits.push({
        offset: keyNode.offset,
        length: keyNode.length,
        replacement: JSON.stringify(next),
      });
    }
  }

  const github = findProperty(root, 'githubRepoPaths');
  const githubValue = github?.children?.[1];
  if (githubValue?.type === 'object') {
    for (const property of githubValue.children ?? []) {
      const list = property.children?.[1];
      if (list?.type !== 'array') continue;

      for (const item of list.children ?? []) {
        if (typeof item.value !== 'string') continue;
        const next = reparent(item.value, opts.src, opts.dst, opts.policy, opts.platform);
        if (next === undefined) continue;

        edits.push({ offset: item.offset, length: item.length, replacement: JSON.stringify(next) });
      }
    }
  }

  return edits;
}

/** 뒤에서부터 적용해야 앞쪽 offset 이 밀리지 않는다. */
export function applyEdits(text: string, edits: ConfigEdit[]): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.offset - a.offset)) {
    out = out.slice(0, edit.offset) + edit.replacement + out.slice(edit.offset + edit.length);
  }
  return out;
}
