/**
 * 트랜스크립트 레코드에서 경로를 담은 필드를 찾아 방문한다.
 *
 * 구조 필드와 서술 필드를 나누는 게 이 파일의 존재 이유다.
 *
 * - 구조 필드는 Claude Code 가 실제로 읽는 값이다. 경로가 바뀌면 반드시 따라가야 한다.
 * - 서술 필드는 대화 본문과 툴 출력이다. "그때 그 경로에서 이 명령을 실행했다" 는 기록이라
 *   고치면 과거가 거짓이 된다. 기본으로 건드리지 않는다.
 *
 * census(어떤 경로가 들어 있나)와 rewrite(경로를 바꾼다)가 **같은 visitor** 를 쓴다.
 * 따로 두면 census 에 안 잡힌 필드를 rewrite 가 건드리는 일이 생기고, 그러면 계획에
 * 없던 변경이 일어난다.
 */

/** 값을 받아 바꿀 문자열을 주거나, 바꾸지 않으려면 undefined 를 준다. */
export type PathVisitor = (value: string) => string | undefined;

export type VisitOptions = {
  /** 서술 필드까지 방문한다. --rewrite-prose 일 때만 true. */
  includeProse?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 객체의 문자열 프로퍼티 하나를 방문한다. 바뀌었으면 true. */
function visitField(holder: unknown, key: string, visit: PathVisitor): boolean {
  if (!isRecord(holder)) return false;
  const current = holder[key];
  if (typeof current !== 'string') return false;
  const next = visit(current);
  if (next === undefined || next === current) return false;
  holder[key] = next;
  return true;
}

/** 문자열 배열 프로퍼티를 방문한다. */
function visitArray(holder: unknown, key: string, visit: PathVisitor): boolean {
  if (!isRecord(holder)) return false;
  const arr = holder[key];
  if (!Array.isArray(arr)) return false;

  let changed = false;
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (typeof item !== 'string') continue;
    const next = visit(item);
    if (next !== undefined && next !== item) {
      arr[i] = next;
      changed = true;
    }
  }
  return changed;
}

/**
 * 레코드의 구조 필드를 전부 방문한다.
 *
 * 레코드의 약 40% 는 `cwd` 조차 없다 (mode, permission-mode, cost-state 같은 사이드카 타입).
 * 그래서 모든 접근이 방어적이어야 한다. 하나라도 가정하면 이관 도중에 터진다.
 */
/**
 * 작업 디렉터리를 뜻하는 필드만 방문한다.
 *
 * 나머지 구조 필드와 나누는 이유가 있다. 어떤 파일이 "이 프로젝트 것인가" 와
 * "cwd 가 섞였는가" 는 오직 cwd 계열 필드로 판단해야 한다. planFilePath 나
 * attachment.path 까지 섞어서 세면, 플랜을 참조했을 뿐인 세션이 전부
 * "cwd 가 섞였다" 고 잘못 잡힌다.
 */
export function visitCwdFields(record: unknown, visit: PathVisitor): boolean {
  if (!isRecord(record)) return false;
  let changed = false;

  changed = visitField(record, 'cwd', visit) || changed;

  // 툴 호출 하나당 하나씩 들어간다. 키가 tool_use id 라 미리 알 수 없다.
  const wire = record.wireIngestContext;
  if (isRecord(wire)) {
    for (const key of Object.keys(wire)) {
      changed = visitField(wire[key], 'cwd', visit) || changed;
    }
  }

  const snapshot = isRecord(record.attachment) ? record.attachment.snapshot : undefined;
  if (isRecord(snapshot)) {
    changed = visitField(snapshot, 'workingDirectory', visit) || changed;
    changed = visitArray(snapshot, 'additionalWorkingDirectories', visit) || changed;
  }

  return changed;
}

/**
 * 경로를 담지만 작업 디렉터리는 아닌 구조 필드. 옮길 때는 같이 따라가야 하지만
 * 소유권 판정에는 쓰지 않는다.
 */
export function visitOtherStructuralFields(record: unknown, visit: PathVisitor): boolean {
  if (!isRecord(record)) return false;
  let changed = false;

  changed = visitField(record, 'trackingPath', visit) || changed;

  const attachment = record.attachment;
  if (isRecord(attachment)) {
    changed = visitField(attachment, 'path', visit) || changed;
    changed = visitField(attachment, 'planFilePath', visit) || changed;

    if (Array.isArray(attachment.changes)) {
      for (const change of attachment.changes) {
        changed = visitField(change, 'from', visit) || changed;
      }
    }
  }

  const message = record.message;
  if (isRecord(message) && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      changed = visitField(block.input, 'planFilePath', visit) || changed;
    }
  }

  return changed;
}

/**
 * 구조 필드를 전부 방문한다.
 *
 * 레코드의 약 40% 는 `cwd` 조차 없다 (mode, permission-mode, cost-state 같은 사이드카 타입).
 * 그래서 모든 접근이 방어적이어야 한다. 하나라도 가정하면 이관 도중에 터진다.
 */
export function visitStructuralPaths(record: unknown, visit: PathVisitor): boolean {
  const cwds = visitCwdFields(record, visit);
  const others = visitOtherStructuralFields(record, visit);
  return cwds || others;
}

/** 서술 필드. 기본으로는 방문하지 않는다. */
export function visitProsePaths(record: unknown, visit: PathVisitor): boolean {
  if (!isRecord(record)) return false;
  let changed = false;

  changed = visitField(record.toolUseResult, 'stdout', visit) || changed;
  changed = visitField(record.toolUseResult, 'stderr', visit) || changed;

  const message = record.message;
  if (isRecord(message) && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      changed = visitField(block, 'text', visit) || changed;
      changed = visitField(block, 'content', visit) || changed;
      changed = visitField(block.input, 'command', visit) || changed;
      changed = visitField(block.input, 'file_path', visit) || changed;
    }
  }

  if (Array.isArray(record.rendered)) {
    for (const item of record.rendered) {
      changed = visitField(item, 'content', visit) || changed;
    }
  }

  const wire = record.wireToolInputs;
  if (isRecord(wire)) {
    for (const key of Object.keys(wire)) {
      changed = visitField(wire[key], 'command', visit) || changed;
      changed = visitField(wire[key], 'file_path', visit) || changed;
    }
  }

  const attachment = record.attachment;
  if (isRecord(attachment)) {
    changed = visitField(attachment, 'filename', visit) || changed;
    if (Array.isArray(attachment.files)) {
      for (const file of attachment.files) {
        changed = visitField(file, 'path', visit) || changed;
      }
    }
  }

  return changed;
}

export function visitPaths(record: unknown, visit: PathVisitor, opts?: VisitOptions): boolean {
  const structural = visitStructuralPaths(record, visit);
  const prose = opts?.includeProse ? visitProsePaths(record, visit) : false;
  return structural || prose;
}

/**
 * 레코드에 들어 있는 경로를 모은다. visitor 가 항상 undefined 를 돌려주므로
 * 레코드는 바뀌지 않는다 - rewrite 와 같은 코드로 census 를 내기 위한 것이다.
 */
export function collectPaths(record: unknown, opts?: VisitOptions): string[] {
  const found: string[] = [];
  visitPaths(
    record,
    (value) => {
      found.push(value);
      return undefined;
    },
    opts,
  );
  return found;
}

/**
 * 문자열 안에 박힌 절대 경로를 뽑아낸다.
 *
 * 서술 필드는 구조 필드와 성격이 다르다. `cwd` 는 값 전체가 경로지만, 대화 본문은
 * "cd /Users/me/proj 했습니다" 처럼 문장 가운데 경로가 들어간다. 값 전체만 보면
 * 하나도 못 잡는다.
 */
const PATH_LIKE = /(?:[A-Za-z]:[\\/]|\/|\\\\)[^\s"'`,;:()[\]{}]*/g;

export function extractPaths(value: string): string[] {
  return value.match(PATH_LIKE) ?? [];
}

/**
 * 서술 필드 안의 경로를 부분 문자열로 치환한다.
 *
 * 경계를 봐야 한다. `/src` 를 그냥 바꾸면 `/src-backup` 의 앞부분까지 바뀐다.
 * 뒤따르는 문자가 경로 구분자이거나 경로가 끝나는 자리일 때만 바꾼다.
 */
export function replacePathIn(value: string, from: string, to: string): string {
  let out = '';
  let index = 0;

  for (;;) {
    const found = value.indexOf(from, index);
    if (found === -1) {
      out += value.slice(index);
      return out;
    }

    const after = value[found + from.length];
    const isBoundary =
      after === undefined || after === '/' || after === '\\' || !/[\w.-]/.test(after);

    out += value.slice(index, found) + (isBoundary ? to : from);
    index = found + from.length;
  }
}
