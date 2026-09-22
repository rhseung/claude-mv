---
description: 옮긴 프로젝트의 Claude 상태를 점검하고 필요하면 이관합니다
argument-hint: '[새 경로]'
allowed-tools: Bash(npx --yes @rhseung/claude-mv:*), Bash(claude-mv:*)
---

사용자가 프로젝트 디렉터리를 옮겨서 Claude 기록이 끊겼는지 확인하고, 맞으면 이관합니다.
인자: $ARGUMENTS

## 1. 진단

`npx --yes @rhseung/claude-mv doctor --json` 을 실행한다.
**종료 코드 11 은 고아 상태를 찾았다는 뜻이지 실패가 아니다.** 0 이면 옮길 것이 없다고
답하고 끝낸다.

## 2. 대상 확정

`orphans[].suggestion` 의 confidence 가 0.8 이상이면 그 경로를 제안한다. 없으면 사용자에게
새 경로를 묻는다. 추측으로 경로를 지어내지 않는다.

## 3. 계획 확인

`... --state-only <old> <new> --dry-run --json` 을 실행한다. **종료 코드 10 은 정상이다.**
steps 와 metrics 를 표로 요약하고, records 와 matches 숫자를 그대로 보여준다.

## 4. 실행

사용자가 명시적으로 동의하기 전에는 실행하지 않는다. `--yes` 는 동의를 받은 뒤에만 붙인다.

- 종료 코드 20(locked) 이면 `--force` 를 붙이지 말고, 옛 경로에서 돌고 있는 claude 세션을
  닫으라고 안내한다.
- 종료 코드 31 이면 출력에 적힌 백업 경로를 그대로 전달하고 직접 손대지 않는다.
