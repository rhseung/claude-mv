import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { temporaryDirectory } from 'tempy';
import { describe, expect, it } from 'vitest';

import { COMMAND_NAMES } from '../src/cli/commands.js';
import { complete, formatCandidates } from '../src/cli/complete.js';
import { completionScript } from '../src/cli/completion/index.js';

const sources = {
  projects: () => [{ value: '/w/alpha' }, { value: '/w/beta', description: 'orphaned' }],
  backups: () => [{ value: '20260101-AAA', description: '/w/alpha' }],
  directories: () => [{ value: '/w/sub' }],
  bundles: () => [{ value: './state.tgz' }],
};

const values = (argv: string[]) => complete(argv, sources).map((c) => c.value);

describe('complete', () => {
  it('첫 낱말에는 명령 이름을 준다', () => {
    expect(values([''])).toEqual(COMMAND_NAMES);
  });

  it('접두사로 좁힌다', () => {
    expect(values(['ro'])).toEqual(['rollback']);
  });

  it('경로 인자에는 Claude 가 아는 프로젝트를 준다', () => {
    // 일반 파일 완성은 이 도구에서 거의 쓸모가 없다. 필요한 건 아는 프로젝트다.
    expect(values(['info', ''])).toEqual(['/w/alpha', '/w/beta']);
    expect(values(['rm', ''])).toEqual(['/w/alpha', '/w/beta']);
  });

  it('mv 의 두 번째 인자는 일반 디렉터리다', () => {
    expect(values(['mv', '/w/alpha', ''])).toEqual(['/w/sub']);
  });

  it('rollback 에는 백업 ID 를 준다', () => {
    expect(values(['rollback', ''])).toEqual(['20260101-AAA']);
  });

  it('import 에는 번들 파일을 준다', () => {
    expect(values(['import', ''])).toEqual(['./state.tgz']);
  });

  it('completion 에는 셸 이름을 준다', () => {
    expect(values(['completion', ''])).toEqual(['zsh', 'bash', 'fish']);
  });

  it('플래그 자리에는 그 명령의 플래그를 준다', () => {
    const flags = values(['mv', 'a', 'b', '--dry']);
    expect(flags).toContain('--dry-run');
  });

  it('닫힌 값 집합은 값까지 완성한다', () => {
    expect(values(['ls', '--sort='])).toEqual(['--sort=activity', '--sort=size', '--sort=path']);
  });

  it('설명은 탭으로 붙인다', () => {
    expect(formatCandidates([{ value: 'a', description: 'b' }])).toBe('a\tb');
    expect(formatCandidates([{ value: 'a' }])).toBe('a');
  });
});

describe('completion 스크립트', () => {
  it.each(['zsh', 'bash', 'fish'] as const)('%s 가 생성된다', (shell) => {
    expect(completionScript(shell)).toContain('claude-mv');
  });

  it('zsh 스크립트가 문법에 맞는다', () => {
    // ps-cli 의 completion 이 깨진 채로 오래 남았던 건 이 검사가 없어서다.
    const file = join(temporaryDirectory(), '_claude-mv');
    writeFileSync(file, completionScript('zsh'));
    expect(() => execFileSync('zsh', ['-n', file])).not.toThrow();
  });

  it('zsh 스크립트가 compadd 를 쓴다', () => {
    // compgen 흉내를 내거나 후보를 직접 출력하면 zsh 완성 시스템을 우회하게 되고,
    // 그러면 fzf-tab 같은 게 전혀 걸리지 않는다.
    const script = completionScript('zsh');
    expect(script).toContain('compadd');
    expect(script).toContain('#compdef');
    expect(script).toContain('__complete');
  });
});
