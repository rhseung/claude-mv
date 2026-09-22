import { describe, expect, it } from 'vitest';

import { collides, mangle, mangleHash } from '../src/core/mangle.js';

describe('mangle', () => {
  // 실제 ~/.claude/projects 에 있던 디렉터리 이름들이다. 구현이 Claude Code 와
  // 한 글자라도 어긋나면 이관 결과가 Claude 에게 보이지 않으므로 골든으로 박아 둔다.
  it.each([
    ['/Users/rhseung', '-Users-rhseung'],
    ['/Users/rhseung/.local/share/chezmoi', '-Users-rhseung--local-share-chezmoi'],
    ['/Users/rhseung/Developer/aunionai', '-Users-rhseung-Developer-aunionai'],
    [
      '/Users/rhseung/Developer/aunionai/aunionai-dub-fe',
      '-Users-rhseung-Developer-aunionai-aunionai-dub-fe',
    ],
    [
      '/Users/rhseung/Developer/aunionai/RST-FE-refac',
      '-Users-rhseung-Developer-aunionai-RST-FE-refac',
    ],
    [
      '/Users/rhseung/Library/Application Support/Codenotch/usage-scratch',
      '-Users-rhseung-Library-Application-Support-Codenotch-usage-scratch',
    ],
  ])('%s -> %s', (input, expected) => {
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
    const nfc = '/a/\uD55C'; // 한
    const nfd = '/a/\u1112\u1161\u11AB'; // ᄒ + ᅡ + ᆫ
    expect(mangle(nfc)).not.toBe(mangle(nfd));
  });

  describe('200 자 초과', () => {
    const long = `/Users/rhseung/${'a'.repeat(250)}`;

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
