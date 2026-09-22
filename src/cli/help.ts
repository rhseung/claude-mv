import { COMMANDS, findCommand } from './commands.js';
import { exitCodeTable } from './exit.js';

export function helpText(commandName?: string): string {
  const spec = commandName ? findCommand(commandName) : undefined;
  if (!spec) return rootHelp();

  const lines = [
    `claude-mv ${spec.name} - ${spec.summary}`,
    '',
    `사용법  claude-mv ${spec.name} ${spec.positionals.map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`)).join(' ')} [옵션]`,
  ];

  const args = Object.entries(spec.args);
  if (args.length > 0) {
    lines.push('', '옵션');
    const width = Math.max(...args.map(([n, a]) => n.length + (a.alias ? 4 : 0)));
    for (const [name, arg] of args) {
      const flag = `${arg.alias ? `-${arg.alias}, ` : ''}--${name}`;
      lines.push(`  ${flag.padEnd(width + 6)}${arg.description}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function rootHelp(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return [
    'claude-mv - 프로젝트 디렉터리를 옮기면서 Claude Code 상태까지 같이 옮깁니다',
    '',
    '사용법  claude-mv <src> <dst>        디렉터리와 상태를 함께 옮깁니다',
    '        claude-mv <명령> [인자]',
    '',
    '명령',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width + 2)}${c.summary}`),
    '',
    '종료 코드',
    ...exitCodeTable.map(([code, why]) => `  ${String(code).padStart(3)}  ${why}`),
    '',
    '자동완성  eval "$(claude-mv completion zsh)"',
    '',
  ].join('\n');
}
