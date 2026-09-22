export type Shell = 'zsh' | 'bash' | 'fish';

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
