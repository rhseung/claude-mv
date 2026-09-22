import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 이 도구는 사용자의 ~/.claude 를 고친다. 테스트가 경로 해석을 한 군데라도 놓치면
// 진짜 홈 디렉터리를 건드리게 되므로, 아예 HOME 자체를 임시 디렉터리로 가둔다.
// src/shared/env.ts 외에서 process.env 를 읽지 못하게 하는 eslint 규칙과 한 쌍이다.
const sandbox = mkdtempSync(join(tmpdir(), 'claude-mv-test-'));

process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
process.env.XDG_CACHE_HOME = join(sandbox, '.cache');
delete process.env.CLAUDE_CONFIG_DIR;

export { sandbox };
