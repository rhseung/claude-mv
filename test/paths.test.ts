import { describe, expect, it } from 'vitest';

import { isUnder, normalizePath, pathEquals, reparent } from '../src/core/paths.js';

const posix = { platform: 'linux' as const, home: '/home/me', realpath: false as const };
const win = { platform: 'win32' as const, home: 'C:\\Users\\me', realpath: false as const };

describe('normalizePath', () => {
  it('~ 를 홈으로 편다', () => {
    expect(normalizePath('~', posix)).toBe('/home/me');
    expect(normalizePath('~/proj', posix)).toBe('/home/me/proj');
  });

  it('~user 는 펴지 않는다', () => {
    expect(normalizePath('~other/proj', posix)).not.toContain('/home/me/');
  });

  it('후행 슬래시를 벗기되 루트는 남긴다', () => {
    expect(normalizePath('/a/b/', posix)).toBe('/a/b');
    expect(normalizePath('/', posix)).toBe('/');
  });

  it('.. 를 접는다', () => {
    expect(normalizePath('/a/b/../c', posix)).toBe('/a/c');
  });

  describe('windows', () => {
    it('드라이브 문자를 대문자로 맞춘다', () => {
      // 소문자로 두면 mangling 결과가 c--Users... 가 되어 다른 디렉터리를 가리킨다.
      expect(normalizePath('c:\\Users\\x\\proj', win)).toBe('C:\\Users\\x\\proj');
    });

    it('\\\\?\\ 접두사를 떼어낸다', () => {
      expect(normalizePath('\\\\?\\C:\\Users\\x', win)).toBe('C:\\Users\\x');
    });

    it('\\\\?\\UNC\\ 를 UNC 형태로 되돌린다', () => {
      expect(normalizePath('\\\\?\\UNC\\server\\share\\p', win)).toBe('\\\\server\\share\\p');
    });

    it('슬래시를 백슬래시로 맞춘다', () => {
      expect(normalizePath('C:/Users/x/proj', win)).toBe('C:\\Users\\x\\proj');
    });

    it('UNC 루트는 벗기지 않는다', () => {
      expect(normalizePath('\\\\server\\share\\', win)).toBe('\\\\server\\share\\');
    });
  });
});

describe('isUnder', () => {
  it('접두사가 같아도 다른 디렉터리면 하위가 아니다', () => {
    // startsWith 로 짜면 여기서 틀린다.
    expect(isUnder('/src-backup/x', '/src', 'sensitive')).toBe(false);
    expect(isUnder('/src/x', '/src', 'sensitive')).toBe(true);
  });

  it('자기 자신은 하위가 아니다', () => {
    expect(isUnder('/src', '/src', 'sensitive')).toBe(false);
  });

  it('대소문자 정책을 따른다', () => {
    expect(isUnder('/SRC/x', '/src', 'sensitive')).toBe(false);
    expect(isUnder('/SRC/x', '/src', 'insensitive')).toBe(true);
  });
});

describe('pathEquals', () => {
  it('insensitive 는 ASCII 만 접는다', () => {
    expect(pathEquals('/Users/Ilya', '/users/ilya', 'insensitive')).toBe(true);
    // 터키어 로케일에서 I -> ı 로 접히면 여기가 깨진다.
    expect(pathEquals('/Users/Ilya', '/users/\u0131lya', 'insensitive')).toBe(false);
  });
});

describe('reparent', () => {
  it('정확히 일치하면 대상 경로', () => {
    expect(reparent('/a/old', '/a/old', '/a/new', 'sensitive', 'linux')).toBe('/a/new');
  });

  it('하위 경로를 옮긴다', () => {
    expect(reparent('/a/old/src/x.ts', '/a/old', '/a/new', 'sensitive', 'linux')).toBe(
      '/a/new/src/x.ts',
    );
  });

  it('대상이 아니면 undefined', () => {
    expect(reparent('/b/other', '/a/old', '/a/new', 'sensitive', 'linux')).toBeUndefined();
    expect(reparent('/a/old-backup', '/a/old', '/a/new', 'sensitive', 'linux')).toBeUndefined();
  });

  it('케이스로 매칭해도 결과는 원본 대소문자를 살린다', () => {
    // 접은 문자열을 그대로 돌려주면 /users 로 저장되어 mangling 이 달라진다.
    expect(reparent('/A/OLD/Sub', '/a/old', '/a/new', 'insensitive', 'linux')).toBe('/a/new/Sub');
  });

  it('windows 경로', () => {
    expect(reparent('C:\\a\\old\\src', 'C:\\a\\old', 'C:\\a\\new', 'insensitive', 'win32')).toBe(
      'C:\\a\\new\\src',
    );
  });
});

describe('reparent 상대 경로', () => {
  it('상대 경로는 대상이 아니다', () => {
    // 실제 트랜스크립트의 attachment 필드에 이런 값들이 들어 있다.
    expect(reparent('.zshrc', '/a/old', '/a/new', 'sensitive', 'linux')).toBeUndefined();
    expect(
      reparent('.local/share/chezmoi/Brewfile', '/a/old', '/a/new', 'sensitive', 'linux'),
    ).toBeUndefined();
  });
});
