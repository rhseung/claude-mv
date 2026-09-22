import { readFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';

import { describe, expect, it } from 'vitest';

import { records, writeTranscript } from './fixtures/transcript.js';
import {
  censusTranscript,
  ConcurrentModificationError,
  rewriteTranscript,
  stagingPathFor,
} from '../src/core/jsonl.js';
import { reparent } from '../src/core/paths.js';

const OLD = '/Users/me/dev/old-name';
const NEW = '/Users/me/dev/new-name';

const mapper = (value: string) => reparent(value, OLD, NEW, 'sensitive', 'linux');
const matchesNothing = () => undefined;

describe('바이트 동일성', () => {
  it.each([
    ['보통', {}],
    ['CRLF', { crlf: true }],
    ['마지막 줄에 줄바꿈 없음', { noFinalNewline: true }],
    ['마지막 줄이 잘림', { truncateLast: true }],
  ])('%s: 아무것도 매치하지 않으면 입출력 해시가 같다', async (_label, opts) => {
    const { file } = writeTranscript(
      [
        records.user(OLD),
        records.pathless(),
        records.withWire(OLD),
        records.withSnapshot(OLD, ['/other/root']),
        records.proseOnly(OLD),
      ],
      opts,
    );

    const result = await rewriteTranscript(file, matchesNothing);
    expect(result.sha256In).toBe(result.sha256Out);
    expect(result.linesChanged).toBe(0);
    expect(result.staged).toBeNull();
  });

  it('숫자와 유니코드 표현이 보존된다', async () => {
    const { file } = writeTranscript([]);
    const raw = '{"type":"x","n":1.0,"s":"caf\\u00e9","e":1e3}\n';
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, raw);

    const result = await rewriteTranscript(file, matchesNothing);
    expect(result.sha256In).toBe(result.sha256Out);
    expect(readFileSync(file, 'utf8')).toBe(raw);
  });
});

describe('rewriteTranscript', () => {
  it('구조 필드만 바꾸고 서술 필드는 그대로 둔다', async () => {
    const { file } = writeTranscript([records.user(OLD), records.proseOnly(OLD)]);

    const result = await rewriteTranscript(file, mapper);
    expect(result.linesChanged).toBe(1);

    const out = readFileSync(result.staged!, 'utf8').trim().split('\n');
    expect(JSON.parse(out[0]!).cwd).toBe(NEW);
    expect(out[1]).toContain(OLD);
  });

  it('--rewrite-prose 면 서술 필드도 바꾼다', async () => {
    const { file } = writeTranscript([records.proseOnly(OLD)]);
    const result = await rewriteTranscript(file, (v) => (v === OLD ? NEW : undefined), {
      includeProse: true,
    });
    expect(result.linesChanged).toBe(0);
  });

  it('하위 경로를 따라 옮긴다', async () => {
    const { file } = writeTranscript([records.withSnapshot(`${OLD}/src`, [`${OLD}/docs`])]);
    const result = await rewriteTranscript(file, mapper);

    const out = JSON.parse(readFileSync(result.staged!, 'utf8').trim());
    expect(out.cwd).toBe(`${NEW}/src`);
    expect(out.attachment.snapshot.workingDirectory).toBe(`${NEW}/src`);
    expect(out.attachment.snapshot.additionalWorkingDirectories).toEqual([`${NEW}/docs`]);
    expect(out.attachment.path).toBe('.zshrc');
  });

  it('파싱 안 되는 줄도 버리지 않는다', async () => {
    const { file } = writeTranscript([records.user(OLD)], { truncateLast: true });
    const result = await rewriteTranscript(file, mapper);

    expect(result.linesMalformed).toBe(1);
    expect(readFileSync(result.staged!, 'utf8')).toContain('unterm');
  });
});

describe('censusTranscript', () => {
  it('경로별 등장 횟수와 경로 없는 레코드를 센다', async () => {
    const { file } = writeTranscript([
      records.user(OLD),
      records.user(OLD),
      records.user('/somewhere/else'),
      records.pathless(),
      records.proseOnly(OLD),
    ]);

    const census = await censusTranscript(file);
    expect(census.paths.get(OLD)).toBe(2);
    expect(census.paths.get('/somewhere/else')).toBe(1);
    expect(census.pathless).toBe(2);
  });

  it('한 파일 안에 cwd 가 섞인 경우를 잡아낸다', async () => {
    const { file } = writeTranscript([
      records.user('/Users/me'),
      records.user('/Users/me/.local/share/chezmoi'),
      records.user('/Users/me/.local/share/chezmoi'),
    ]);

    const census = await censusTranscript(file);
    expect(census.paths.size).toBe(2);
  });

  it('상대 경로는 세지 않는다', async () => {
    const { file } = writeTranscript([records.withSnapshot(OLD)]);
    const census = await censusTranscript(file);
    expect([...census.paths.keys()]).not.toContain('.zshrc');
  });
});

describe('동시 수정', () => {
  it('읽는 동안 파일이 바뀌면 조용히 덮지 않고 실패한다', async () => {
    const { file } = writeTranscript([records.user(OLD)]);
    const { appendFileSync } = await import('node:fs');

    const racing = (value: string) => {
      appendFileSync(file, `${JSON.stringify(records.user(OLD))}\n`);
      return reparent(value, OLD, NEW, 'sensitive', 'linux');
    };

    await expect(rewriteTranscript(file, racing)).rejects.toThrow(ConcurrentModificationError);
  });
});

describe('stagingPathFor', () => {
  it('같은 디렉터리에 임시 이름을 만든다', () => {
    expect(stagingPathFor('/a/b/s1.jsonl', 'stage', posix)).toBe('/a/b/s1.jsonl.claude-mv-stage');
  });

  it('윈도우 경로에서도 디렉터리를 벗어나지 않는다', () => {
    expect(stagingPathFor('C:\\a\\b\\s1.jsonl', 'stage', win32)).toBe(
      'C:\\a\\b\\s1.jsonl.claude-mv-stage',
    );
  });
});
