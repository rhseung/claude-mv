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

function isAbsolutePathish(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

export type LineRecord = {
  raw: Buffer;
  terminator: Buffer;
  index: number;
};

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

  if (carry.length > 0) {
    yield { raw: carry, terminator: Buffer.alloc(0), index };
  }
}

export type TranscriptCensus = {
  file: string;
  lines: number;
  bytes: number;
  paths: Map<string, number>;
  cwds: Map<string, number>;
  prose: Map<string, number>;
  pathless: number;
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

    const onThisLine = new Set<string>();
    const cwdsOnThisLine = new Set<string>();

    const collect = (into: Set<string>) => (value: string) => {
      if (isAbsolutePathish(value)) into.add(value);
      return undefined;
    };

    const proseOnThisLine = new Set<string>();

    visitPaths(record, collect(onThisLine), opts);
    visitCwdFields(record, collect(cwdsOnThisLine));
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

export class ConcurrentModificationError extends Error {
  constructor(readonly file: string) {
    super(`재작성하는 동안 파일이 바뀌었습니다: ${file}`);
    this.name = 'ConcurrentModificationError';
  }
}

export type RewriteResult = {
  linesTotal: number;
  linesChanged: number;
  linesMalformed: number;
  sha256In: string;
  sha256Out: string;
  staged: string | null;
};

export async function rewriteTranscript(
  filePath: string,
  visit: PathVisitor,
  opts?: VisitOptions & { stagingSuffix?: string },
): Promise<RewriteResult> {
  return rewriteJsonl(filePath, (record) => visitPaths(record, visit, opts), opts);
}

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

  const before = await stat(filePath);

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

    const after = await stat(filePath);
    if (after.size !== before.size || after.ino !== before.ino) {
      throw new ConcurrentModificationError(filePath);
    }

    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });

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

export async function commitStaged(staging: string, target: string): Promise<void> {
  await rename(staging, target);
}
