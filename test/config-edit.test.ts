import { describe, expect, it } from 'vitest';

import { applyEdits, planConfigEdits } from '../src/core/config-edit.js';

const opts = {
  src: '/Users/me/old',
  dst: '/Users/me/new',
  policy: 'sensitive' as const,
  platform: 'linux' as const,
};

describe('planConfigEdits', () => {
  it('키 문자열이 놓인 바이트 구간만 잡는다', () => {
    const text = `{\n  "projects": {\n    "/Users/me/old": { "lastCost": 1 }\n  }\n}`;
    const edits = planConfigEdits(text, opts);

    expect(edits).toHaveLength(1);
    expect(text.slice(edits[0]!.offset, edits[0]!.offset + edits[0]!.length)).toBe(
      '"/Users/me/old"',
    );
  });

  it('다른 키와 값과 포맷을 전부 보존한다', () => {
    const text = [
      '{',
      '  "oauthAccount": { "token": "secret-value" },',
      '  "unknownFutureKey": [1.0, 1e3, "caf\\u00e9"],',
      '  "projects": {',
      '    "/Users/me/old": { "lastCost": 1.50, "allowedTools": [] },',
      '    "/Users/me/other": { "lastCost": 2 }',
      '  }',
      '}',
    ].join('\n');

    const out = applyEdits(text, planConfigEdits(text, opts));

    expect(out).toContain('"token": "secret-value"');
    expect(out).toContain('[1.0, 1e3, "caf\\u00e9"]');
    expect(out).toContain('"lastCost": 1.50');
    expect(out).toContain('"/Users/me/other"');
    expect(out).toContain('"/Users/me/new"');
    expect(out).not.toContain('"/Users/me/old"');
  });

  it('githubRepoPaths 의 배열 원소도 바꾼다', () => {
    const text = `{ "githubRepoPaths": { "me/repo": ["/Users/me/old", "/elsewhere"] } }`;
    const out = applyEdits(text, planConfigEdits(text, opts));

    expect(out).toContain('"/Users/me/new"');
    expect(out).toContain('"/elsewhere"');
  });

  it('하위 경로도 따라 옮긴다', () => {
    const text = `{ "projects": { "/Users/me/old/sub": {} } }`;
    const out = applyEdits(text, planConfigEdits(text, opts));
    expect(out).toContain('"/Users/me/new/sub"');
  });

  it('접두사만 같은 경로는 건드리지 않는다', () => {
    const text = `{ "projects": { "/Users/me/old-backup": {} } }`;
    expect(planConfigEdits(text, opts)).toHaveLength(0);
  });

  it('대상이 없으면 편집도 없다', () => {
    expect(planConfigEdits(`{ "projects": {} }`, opts)).toHaveLength(0);
    expect(planConfigEdits('not json at all', opts)).toHaveLength(0);
  });
});
