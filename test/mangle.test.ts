import { describe, expect, it } from 'vitest';

import { collides, mangle, mangleHash } from '../src/core/mangle.js';

describe('mangle', () => {
  it.each([
    ['평범한 경로', '/Users/me', '-Users-me'],
    ['숨김 디렉터리', '/Users/me/.local/share/chezmoi', '-Users-me--local-share-chezmoi'],
    ['이름 안의 하이픈', '/Users/me/dev/web-app', '-Users-me-dev-web-app'],
    ['대문자', '/Users/me/dev/API-V2', '-Users-me-dev-API-V2'],
    [
      '공백',
      '/Users/me/Library/Application Support/Tool/scratch',
      '-Users-me-Library-Application-Support-Tool-scratch',
    ],
  ])('%s: %s -> %s', (_label, input, expected) => {
    expect(mangle(input)).toBe(expected);
  });

  it('윈도우 경로의 콜론과 백슬래시도 대시가 된다', () => {
    expect(mangle('C:\\Users\\x\\proj')).toBe('C--Users-x-proj');
    expect(mangle('\\\\server\\share\\proj')).toBe('--server-share-proj');
  });

  it('한글은 UTF-16 code unit 하나당 대시 하나', () => {
    expect(mangle('/a/프로젝트')).toBe('-a-----');
  });

  it('NFC 와 NFD 는 서로 다른 이름이 된다', () => {
    const nfc = '/a/\uD55C';
    const nfd = '/a/\u1112\u1161\u11AB';
    expect(mangle(nfc)).not.toBe(mangle(nfd));
  });

  describe('200 자 초과', () => {
    const long = `/Users/me/${'a'.repeat(250)}`;

    it('200 자로 자르고 base36 해시를 붙인다', () => {
      const got = mangle(long);
      expect(got.slice(0, 200)).toBe(long.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200));
      expect(got).toMatch(/^.{200}-[0-9a-z]+$/);
    });

    it('해시 인자는 치환된 문자열이 아니라 원본 경로다', () => {
      const suffix = mangle(long).slice(201);
      expect(suffix).toBe(Math.abs(mangleHash(long)).toString(36));
      expect(suffix).not.toBe(
        Math.abs(mangleHash(long.replace(/[^a-zA-Z0-9]/g, '-'))).toString(36),
      );
    });

    it('200 자 이하는 해시를 붙이지 않는다', () => {
      const edge = `/${'a'.repeat(199)}`;
      expect(mangle(edge)).toHaveLength(200);
      expect(mangle(edge)).not.toContain('-a-');
    });
  });
});

describe('collides', () => {
  it('구분자와 하이픈을 구별하지 못한다', () => {
    expect(mangle('/a/b-c')).toBe(mangle('/a/b/c'));
    expect(collides('/a/b-c', '/a/b/c')).toBe(true);
  });

  it('같은 경로는 충돌이 아니다', () => {
    expect(collides('/a/b', '/a/b')).toBe(false);
  });
});
