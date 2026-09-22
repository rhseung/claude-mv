export type Shell = 'zsh' | 'bash' | 'fish';

/**
 * 껍데기만 내보내고 실제 후보는 셸이 CLI 에 되물어서 받는다.
 *
 * 정적 파일에 명령 목록을 박아두면 명령을 추가할 때마다 손으로 고쳐야 하고,
 * 안 고치면 조용히 어긋난다. 그리고 이 도구에서 정말 필요한 후보는
 * "Claude 가 아는 프로젝트 경로" 라서 어차피 프로세스에 물어봐야 한다.
 */
export function completionScript(shell: Shell, bin = 'claude-mv'): string {
  switch (shell) {
    case 'zsh':
      return zsh(bin);
    case 'bash':
      return bash(bin);
    case 'fish':
      return fish(bin);
  }
}

/**
 * compadd 로 후보를 넣는다. compgen 흉내를 내거나 후보를 직접 출력하면 zsh 의
 * 완성 시스템을 우회하게 되고, 그러면 fzf-tab 같은 게 전혀 걸리지 않는다.
 * 여기서는 표준 경로를 타므로 fzf-tab 이 아무 설정 없이 동작한다.
 */
function zsh(bin: string): string {
  return `#compdef ${bin}

_${bin.replace(/-/g, '_')}() {
  local -a lines values descriptions
  local line value

  lines=(\${(f)"$(${bin} __complete "\${(@)words[2,$CURRENT]}" 2>/dev/null)"})

  for line in $lines; do
    [[ -z "$line" ]] && continue
    value=\${line%%$'\\t'*}
    values+=("$value")
    if [[ "$line" == *$'\\t'* ]]; then
      descriptions+=("\${value} -- \${line#*$'\\t'}")
    else
      descriptions+=("$value")
    fi
  done

  (( \${#values} )) || return 1
  compadd -Q -d descriptions -a values
}

compdef _${bin.replace(/-/g, '_')} ${bin}
`;
}

function bash(bin: string): string {
  return `_${bin.replace(/-/g, '_')}() {
  local IFS=$'\\n'
  local candidates
  candidates=( $(${bin} __complete "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null | cut -f1) )
  COMPREPLY=( $(compgen -W "\${candidates[*]}" -- "\${COMP_WORDS[COMP_CWORD]}") )
}

complete -o default -F _${bin.replace(/-/g, '_')} ${bin}
`;
}

function fish(bin: string): string {
  return `function __${bin.replace(/-/g, '_')}_complete
  set -l tokens (commandline -opc) (commandline -ct)
  ${bin} __complete $tokens[2..-1] 2>/dev/null
end

complete -c ${bin} -f -a '(__${bin.replace(/-/g, '_')}_complete)'
`;
}
