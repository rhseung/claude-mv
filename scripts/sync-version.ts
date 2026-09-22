import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * package.json 의 버전을 플러그인 매니페스트로 옮긴다.
 *
 * 한 레포에 CLI 와 플러그인이 같이 있어서 버전이 두 군데에 적힌다. 어긋나면
 * 사용자가 받은 플러그인과 CLI 가 다른 물건이 되므로 CI 가 --check 로 막는다.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginManifest = join(root, 'plugin', '.claude-plugin', 'plugin.json');

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string;
};
const plugin = JSON.parse(readFileSync(pluginManifest, 'utf8')) as { version: string };

if (process.argv.includes('--check')) {
  if (plugin.version !== version) {
    process.stderr.write(
      `plugin.json 이 ${plugin.version}, package.json 이 ${version} 입니다. bun run sync:version 을 실행하고 커밋하세요.\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}

plugin.version = version;
writeFileSync(pluginManifest, `${JSON.stringify(plugin, null, 2)}\n`);
process.stdout.write(`plugin.json -> ${version}\n`);
