import { modify, parseTree, type Node } from 'jsonc-parser';

import { reparent, type CasePolicy } from './paths.js';

export type ConfigEdit = { offset: number; length: number; replacement: string };

function findProperty(node: Node | undefined, key: string): Node | undefined {
  if (node?.type !== 'object') return undefined;
  return node.children?.find((child) => child.children?.[0]?.value === key);
}

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

export function applyEdits(text: string, edits: ConfigEdit[]): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.offset - a.offset)) {
    out = out.slice(0, edit.offset) + edit.replacement + out.slice(edit.offset + edit.length);
  }
  return out;
}

export function planConfigRemoval(text: string, key: string): ConfigEdit[] {
  return modify(text, ['projects', key], undefined, {}).map((edit) => ({
    offset: edit.offset,
    length: edit.length,
    replacement: edit.content,
  }));
}
