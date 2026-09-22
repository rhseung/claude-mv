import { describe, expect, it } from 'vitest';

import { COMMAND_NAMES, dispatch, findCommand } from '../src/cli/commands.js';
import { CliError } from '../src/cli/exit.js';
import { bool, parseArgs, requirePositionals, str } from '../src/cli/parse.js';

const mv = findCommand('mv')!;

describe('dispatch', () => {
  it('맨 앞의 명령 이름을 고른다', () => {
    expect(dispatch(['doctor'])).toEqual({ command: 'doctor', rest: [] });
  });

  it('명령 이름이 없으면 mv 로 본다', () => {
    expect(dispatch(['a', 'b'])).toEqual({ command: 'mv', rest: ['a', 'b'] });
  });

  it('전역 플래그가 앞에 와도 명령을 찾는다', () => {
    // `git --git-dir=X status` 처럼 흔한 형태다. 이게 깨지면 ls 가 mv 의 인자로 먹힌다.
    expect(dispatch(['--claude-home', '/tmp/x', 'ls'])).toEqual({
      command: 'ls',
      rest: ['--claude-home', '/tmp/x'],
    });
    expect(dispatch(['--claude-home=/tmp/x', 'doctor'])).toEqual({
      command: 'doctor',
      rest: ['--claude-home=/tmp/x'],
    });
    expect(dispatch(['--json', 'doctor'])).toEqual({ command: 'doctor', rest: ['--json'] });
  });

  it('boolean 플래그는 값을 먹지 않는다', () => {
    expect(dispatch(['--json', 'ls'])).toEqual({ command: 'ls', rest: ['--json'] });
  });

  it('-- 뒤는 전부 mv 의 인자다', () => {
    // doctor 라는 이름의 디렉터리를 옮기는 탈출구.
    expect(dispatch(['--', 'doctor', 'new'])).toEqual({ command: 'mv', rest: ['doctor', 'new'] });
  });

  it('__complete 는 따로 받는다', () => {
    expect(dispatch(['__complete', 'mv', ''])).toEqual({ command: '__complete', rest: ['mv', ''] });
  });

  it('모든 명령 이름이 dispatch 된다', () => {
    for (const name of COMMAND_NAMES) {
      expect(dispatch([name]).command).toBe(name);
    }
  });
});

describe('parseArgs', () => {
  it('위치 인자와 플래그를 나눈다', () => {
    const parsed = parseArgs(mv, ['old', 'new', '--dry-run']);
    expect(parsed.positionals).toEqual(['old', 'new']);
    expect(bool(parsed, 'dry-run')).toBe(true);
  });

  it('짧은 별칭', () => {
    expect(bool(parseArgs(mv, ['a', 'b', '-n']), 'dry-run')).toBe(true);
    expect(bool(parseArgs(mv, ['a', 'b', '-y']), 'yes')).toBe(true);
  });

  it('--flag=value 와 --flag value 둘 다', () => {
    expect(str(parseArgs(mv, ['a', 'b', '--claude-home=/x']), 'claude-home')).toBe('/x');
    expect(str(parseArgs(mv, ['a', 'b', '--claude-home', '/x']), 'claude-home')).toBe('/x');
  });

  it('이름이 no- 로 시작하는 플래그를 그대로 받는다', () => {
    // --no-backup 은 backup 을 끄는 게 아니라 그 자체가 플래그 이름이다.
    expect(bool(parseArgs(mv, ['a', 'b', '--no-backup']), 'no-backup')).toBe(true);
  });

  it('모르는 옵션은 사용법 오류', () => {
    expect(() => parseArgs(mv, ['a', 'b', '--nope'])).toThrow(CliError);
  });

  it('값이 빠진 옵션은 사용법 오류', () => {
    expect(() => parseArgs(mv, ['a', 'b', '--claude-home'])).toThrow(CliError);
  });

  it('닫힌 값 집합을 검사한다', () => {
    const ls = findCommand('ls')!;
    expect(str(parseArgs(ls, ['--sort', 'size']), 'sort')).toBe('size');
    expect(() => parseArgs(ls, ['--sort', 'nonsense'])).toThrow(CliError);
  });

  it('기본값을 채운다', () => {
    expect(str(parseArgs(findCommand('ls')!, []), 'sort')).toBe('activity');
  });

  it('-- 뒤는 전부 위치 인자다', () => {
    expect(parseArgs(mv, ['--', '--weird-dir-name', 'new']).positionals).toEqual([
      '--weird-dir-name',
      'new',
    ]);
  });

  it('필수 위치 인자가 모자라면 오류', () => {
    expect(() => requirePositionals(mv, parseArgs(mv, ['only-one']))).toThrow(CliError);
  });
});
