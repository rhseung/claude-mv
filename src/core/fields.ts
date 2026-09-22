export type PathVisitor = (value: string) => string | undefined;

export type VisitOptions = {
  includeProse?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function visitField(holder: unknown, key: string, visit: PathVisitor): boolean {
  if (!isRecord(holder)) return false;
  const current = holder[key];
  if (typeof current !== 'string') return false;
  const next = visit(current);
  if (next === undefined || next === current) return false;
  holder[key] = next;
  return true;
}

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

export function visitCwdFields(record: unknown, visit: PathVisitor): boolean {
  if (!isRecord(record)) return false;
  let changed = false;

  changed = visitField(record, 'cwd', visit) || changed;

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

export function visitStructuralPaths(record: unknown, visit: PathVisitor): boolean {
  const cwds = visitCwdFields(record, visit);
  const others = visitOtherStructuralFields(record, visit);
  return cwds || others;
}

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

const PATH_LIKE = /(?:[A-Za-z]:[\\/]|\/|\\\\)[^\s"'`,;:()[\]{}]*/g;

export function extractPaths(value: string): string[] {
  return value.match(PATH_LIKE) ?? [];
}

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
