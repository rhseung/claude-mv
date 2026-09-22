import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'claude-mv-test-'));

process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
process.env.XDG_CACHE_HOME = join(sandbox, '.cache');
delete process.env.CLAUDE_CONFIG_DIR;

export { sandbox };
