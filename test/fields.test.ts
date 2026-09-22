import { describe, expect, it } from 'vitest';

import { extractPaths, replacePathIn } from '../src/core/fields.js';

describe('extractPaths', () => {
  it('문장 가운데 박힌 경로를 뽑는다', () => {
    // 서술 필드는 값 전체가 경로가 아니다. 그래서 구조 필드와 같은 방식으로는 못 잡는다.
    expect(extractPaths('cd /Users/me/proj 했습니다')).toEqual(['/Users/me/proj']);
  });

  it('여러 개도 뽑는다', () => {
    expect(extractPaths('mv /a/b /c/d')).toEqual(['/a/b', '/c/d']);
  });

  it('윈도우 경로와 UNC', () => {
    expect(extractPaths('at C:\\Users\\x\\p done')).toEqual(['C:\\Users\\x\\p']);
    expect(extractPaths('see \\\\server\\share\\p')).toContain('\\\\server\\share\\p');
  });

  it('따옴표와 괄호에서 끊는다', () => {
    expect(extractPaths('"/a/b" (/c/d)')).toEqual(['/a/b', '/c/d']);
  });

  it('경로가 없으면 빈 배열', () => {
    expect(extractPaths('그냥 문장입니다')).toEqual([]);
  });
});

describe('replacePathIn', () => {
  it('경로를 바꾼다', () => {
    expect(replacePathIn('cd /a/old 했습니다', '/a/old', '/a/new')).toBe('cd /a/new 했습니다');
  });

  it('하위 경로도 따라간다', () => {
    expect(replacePathIn('/a/old/src/x.ts', '/a/old', '/a/new')).toBe('/a/new/src/x.ts');
  });

  it('접두사만 같은 경로는 건드리지 않는다', () => {
    // 경계를 안 보면 /a/old-backup 의 앞부분까지 바뀐다.
    expect(replacePathIn('/a/old-backup/x', '/a/old', '/a/new')).toBe('/a/old-backup/x');
  });

  it('한 문자열 안의 여러 곳을 전부 바꾼다', () => {
    expect(replacePathIn('mv /a/old /a/old/sub', '/a/old', '/a/new')).toBe('mv /a/new /a/new/sub');
  });

  it('섞여 있으면 맞는 것만 바꾼다', () => {
    expect(replacePathIn('/a/old 와 /a/older', '/a/old', '/a/new')).toBe('/a/new 와 /a/older');
  });

  it('없으면 그대로', () => {
    expect(replacePathIn('관계없는 문장', '/a/old', '/a/new')).toBe('관계없는 문장');
  });
});
