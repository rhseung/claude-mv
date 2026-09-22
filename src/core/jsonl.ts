import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  visitCwdFields,
  visitPaths,
  extractPaths,
  visitProsePaths,
  type PathVisitor,
  type VisitOptions,
} from './fields.js';

const LF = 0x0a;

/** posix 절대 경로, 윈도우 드라이브 경로, UNC 경로. 나머지는 상대 경로로 본다. */
function isAbsolutePathish(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

export type LineRecord = {
  /** 줄바꿈을 뺀 원본 바이트. 절대 문자열로 왕복시키지 않는다. */
  raw: Buffer;
  /** 이 줄의 줄바꿈 바이트. 마지막 줄은 비어 있을 수 있다. */
  terminator: Buffer;
  index: number;
};

/**
 * JSONL 을 줄 단위로 흘려보낸다. 줄바꿈 형태(LF / CRLF / 없음)를 바이트 그대로 들고 간다.
 *
 * readline 을 쓰지 않는 이유: 문자열로 바꿔주면서 줄바꿈을 정규화해버려서, 손대지 않은 줄을
 * 원본 바이트 그대로 되쓸 수 없게 된다. 그게 이 도구의 핵심 보장이다.
 */
export async function* readLines(filePath: string): AsyncGenerator<LineRecord> {
  const stream = createReadStream(filePath);
  let carry: Buffer = Buffer.alloc(0);
  let index = 0;

  for await (const chunk of stream) {
    carry = carry.length === 0 ? (chunk as Buffer) : Buffer.concat([carry, chunk as Buffer]);

    let start = 0;
    for (;;) {
      const nl = carry.indexOf(LF, start);
      if (nl === -1) break;

      const hasCr = nl > start && carry[nl - 1] === 0x0d;
      yield {
        raw: carry.subarray(start, hasCr ? nl - 1 : nl),
        terminator: carry.subarray(hasCr ? nl - 1 : nl, nl + 1),
        index: index++,
      };
      start = nl + 1;
    }
    carry = carry.subarray(start);
  }

  // 줄바꿈 없이 끝나는 마지막 줄. 라이브 세션이 쓰는 중이면 흔하다.
  if (carry.length > 0) {
    yield { raw: carry, terminator: Buffer.alloc(0), index };
  }
}

export type TranscriptCensus = {
  file: string;
  lines: number;
  bytes: number;
  /**
   * 절대 경로별로 그 경로가 등장하는 **줄 수**. 필드 등장 횟수가 아니다.
   * 재작성이 줄 단위로 일어나므로 계획에 필요한 값도 줄 수다. 한 줄에 cwd 와
   * wireIngestContext.cwd 가 같이 있으면 등장 횟수는 2 지만 바뀌는 줄은 1 이다.
   */
  paths: Map<string, number>;
  /**
   * 작업 디렉터리 필드에만 나온 경로별 줄 수. 소유권과 cwd 혼재 판정은 이걸로만 한다.
   * paths 에는 플랜 경로나 attachment 경로가 섞여 있어서 그 판정에 쓸 수 없다.
   */
  cwds: Map<string, number>;
  /**
   * 서술 필드(대화 본문, 툴 출력)에만 나온 경로별 줄 수.
   * 기본으로는 고치지 않지만, 계획 화면에서 "이만큼은 그대로 둡니다" 를 정직하게
   * 보여주려면 실제로 세어야 한다.
   */
  prose: Map<string, number>;
  /** 경로 필드가 아예 없는 레코드 수. 전체의 40% 가량은 정상이다. */
  pathless: number;
  /** JSON 으로 파싱되지 않은 줄의 인덱스. 잘린 마지막 줄은 정상이다. */
  malformed: number[];
};

export async function censusTranscript(
  filePath: string,
  opts?: VisitOptions,
): Promise<TranscriptCensus> {
  const census: TranscriptCensus = {
    file: filePath,
    lines: 0,
    bytes: (await stat(filePath)).size,
    paths: new Map(),
    cwds: new Map(),
    prose: new Map(),
    pathless: 0,
    malformed: [],
  };

  for await (const line of readLines(filePath)) {
    census.lines++;
    if (line.raw.length === 0) continue;

    let record: unknown;
    try {
      record = JSON.parse(line.raw.toString('utf8'));
    } catch {
      census.malformed.push(line.index);
      continue;
    }

    // 한 줄에 같은 경로가 여러 필드에 나와도 바뀌는 줄은 하나다.
    const onThisLine = new Set<string>();
    const cwdsOnThisLine = new Set<string>();

    const collect = (into: Set<string>) => (value: string) => {
      // 상대 경로는 옮길 기준점이 없어 대상이 될 수 없다. census 에서도 뺀다.
      if (isAbsolutePathish(value)) into.add(value);
      return undefined;
    };

    const proseOnThisLine = new Set<string>();

    visitPaths(record, collect(onThisLine), opts);
    visitCwdFields(record, collect(cwdsOnThisLine));
    // 서술 필드는 문장 가운데 경로가 박혀 있어서 값 전체를 보면 못 잡는다.
    visitProsePaths(record, (value) => {
      for (const path of extractPaths(value)) proseOnThisLine.add(path);
      return undefined;
    });

    for (const value of onThisLine) {
      census.paths.set(value, (census.paths.get(value) ?? 0) + 1);
    }
    for (const value of cwdsOnThisLine) {
      census.cwds.set(value, (census.cwds.get(value) ?? 0) + 1);
    }
    for (const value of proseOnThisLine) {
      census.prose.set(value, (census.prose.get(value) ?? 0) + 1);
    }
    if (onThisLine.size === 0) census.pathless++;
  }

  return census;
}

export type RewriteResult = {
  linesTotal: number;
  linesChanged: number;
  linesMalformed: number;
  sha256In: string;
  sha256Out: string;
  /** 바뀐 게 없으면 스테이징 파일을 만들지 않는다. */
  staged: string | null;
};

/**
 * 트랜스크립트를 재작성해 스테이징 파일로 남긴다. 교체(rename)는 호출자가 한다 -
 * 커밋 시점을 저널이 통제해야 하기 때문이다.
 *
 * 바뀌지 않은 줄은 `JSON.stringify` 를 거치지 않고 원본 바이트를 그대로 흘려보낸다.
 * 재직렬화하면 `1.0` 이 `1` 이 되고 `é` 가 `é` 로 풀리는 식으로 값 표현이 달라져서,
 * 손댈 이유가 없는 99% 의 줄까지 바이트가 바뀐다. 그러면 diff 를 검토할 수 없고
 * 하드링크 백업도 의미가 없어진다.
 */
export async function rewriteTranscript(
  filePath: string,
  visit: PathVisitor,
  opts?: VisitOptions & { stagingSuffix?: string },
): Promise<RewriteResult> {
  return rewriteJsonl(filePath, (record) => visitPaths(record, visit, opts), opts);
}

/**
 * 레코드 하나를 고칠지 결정하는 함수. 고쳤으면 true 를 준다.
 * 트랜스크립트와 history.jsonl 은 필드가 달라서 여기를 갈아끼운다.
 */
export type RecordMutator = (record: unknown) => boolean;

export async function rewriteJsonl(
  filePath: string,
  mutate: RecordMutator,
  opts?: { stagingSuffix?: string },
): Promise<RewriteResult> {
  const staging = join(
    dirname(filePath),
    `${filePath.split('/').pop()}.claude-mv-${opts?.stagingSuffix ?? 'tmp'}`,
  );

  const hashIn = createHash('sha256');
  const hashOut = createHash('sha256');
  const out = createWriteStream(staging);

  const result: RewriteResult = {
    linesTotal: 0,
    linesChanged: 0,
    linesMalformed: 0,
    sha256In: '',
    sha256Out: '',
    staged: staging,
  };

  const write = (buf: Buffer): Promise<void> =>
    new Promise((resolve, reject) => {
      out.write(buf, (err) => (err ? reject(err) : resolve()));
    });

  try {
    for await (const line of readLines(filePath)) {
      result.linesTotal++;
      hashIn.update(line.raw).update(line.terminator);

      const emit = async (buf: Buffer) => {
        hashOut.update(buf);
        await write(buf);
      };

      if (line.raw.length === 0) {
        await emit(line.raw);
        await emit(line.terminator);
        continue;
      }

      let record: unknown;
      try {
        record = JSON.parse(line.raw.toString('utf8'));
      } catch {
        // 파싱 실패한 줄은 절대 버리지 않는다. 라이브 세션이 쓰는 중이라 잘렸을 뿐일 수 있다.
        result.linesMalformed++;
        await emit(line.raw);
        await emit(line.terminator);
        continue;
      }

      if (!mutate(record)) {
        await emit(line.raw);
        await emit(line.terminator);
        continue;
      }

      result.linesChanged++;
      await emit(Buffer.from(JSON.stringify(record), 'utf8'));
      await emit(line.terminator);
    }

    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });

    // 스테이징 파일이 디스크에 확실히 닿은 뒤에야 커밋할 수 있다.
    const handle = await open(staging, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(staging, (await stat(filePath)).mode);
  } catch (error) {
    out.destroy();
    await unlink(staging).catch(() => {});
    result.staged = null;
    throw error;
  }

  result.sha256In = hashIn.digest('hex');
  result.sha256Out = hashOut.digest('hex');

  if (result.linesChanged === 0) {
    await unlink(staging).catch(() => {});
    result.staged = null;
  }

  return result;
}

/** 스테이징 파일을 제자리에 올린다. 같은 디렉터리라 rename 이 원자적이다. */
export async function commitStaged(staging: string, target: string): Promise<void> {
  await rename(staging, target);
}
