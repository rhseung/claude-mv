# claude-mv

프로젝트 디렉터리를 옮기면 Claude Code가 그 프로젝트의 세션 기록을 더는 찾지 못한다.
Claude Code가 절대 경로를 키로 삼아 상태를 저장하기 때문이다. 이 도구는 디렉터리와
상태를 함께 옮긴다.

## 문제

`mv`를 한 번 실행하면 아래가 모두 원래 경로와의 연결을 잃는다.

```
~/.claude/projects/-Users-me-dev-old-name/      세션 기록(transcript)
~/.claude.json  projects["/Users/me/dev/old-name"]
~/.claude/history.jsonl  의 project 필드
~/Library/Caches/claude-cli-nodejs/-Users-me-dev-old-name/   MCP 로그
~/.claude/plans/*.md  안의 경로 문자열
```

디렉터리 이름은 경로에서 영숫자가 아닌 문자를 전부 `-`로 바꾼 것이다. 이 변환은
**되돌릴 수 없다.** `/a/b-c`와 `/a/b/c`가 같은 이름이 되기 때문이다. 따라서 디렉터리
이름만 보고 원래 경로를 알아낼 수는 없고, 안에 들어 있는 transcript의 `cwd`를 읽어야 한다.

## 설치

```
npx @rhseung/claude-mv doctor
```

```
bun install -g @rhseung/claude-mv
npm install -g @rhseung/claude-mv
```

## 사용법

먼저 계획을 확인한다. 이 명령은 아무것도 기록하지 않는다.

```
claude-mv --dry-run ~/dev/old-name ~/dev/new-name
```

계획이 의도와 맞으면 실행한다.

```
claude-mv ~/dev/old-name ~/dev/new-name
```

디렉터리를 이미 직접 옮겼다면 상태만 이어서 옮긴다.

```
claude-mv --state-only ~/dev/old-name ~/dev/new-name
```

## 명령

| 명령                | 동작                                                                          |
| ------------------- | ----------------------------------------------------------------------------- |
| `mv <src> <dst>`    | 디렉터리와 상태를 함께 옮긴다. 첫 인자가 명령 이름이 아니면 이것이 기본값이다 |
| `ls`                | Claude가 알고 있는 프로젝트를 전부 보여준다                                   |
| `info <경로>`       | 프로젝트 하나의 상태를 자세히 보여준다                                        |
| `doctor`            | 연결이 끊긴 상태를 찾아내고 어디로 옮겨졌는지 추정한다                        |
| `rm <경로>`         | 프로젝트 하나의 Claude 상태를 삭제한다 (백업 후 진행)                         |
| `merge <from> <to>` | 프로젝트 디렉터리 두 개를 합친다                                              |
| `backup [경로]`     | 이동하지 않고 스냅샷만 만든다                                                 |
| `rollback [id]`     | 백업 목록을 보여주거나 지정한 백업으로 복구한다                               |
| `export <경로>`     | 상태를 tarball로 내보낸다                                                     |
| `import <파일>`     | tarball에서 들여온다. `--to`를 지정하면 이어서 이관한다                       |
| `completion <셸>`   | 자동완성 스크립트를 출력한다                                                  |

| 플래그                 | 의미                                                     |
| ---------------------- | -------------------------------------------------------- |
| `-n, --dry-run`        | 계획만 보여주고 아무것도 기록하지 않는다                 |
| `-y, --yes`            | 확인 프롬프트를 건너뛴다                                 |
| `-f, --force`          | lock과 상태 충돌을 차단 대신 경고로 낮춘다               |
| `--state-only`         | 디렉터리는 그대로 두고 상태만 옮긴다                     |
| `--rewrite-prose`      | 대화 본문에 포함된 경로까지 바꾼다                       |
| `--no-backup`          | 백업을 만들지 않는다. 이 경우 rollback도 불가능하다      |
| `--json`               | 기계가 읽는 출력. 진행 상황은 stderr, 결과 하나는 stdout |
| `--claude-home <경로>` | `~/.claude` 위치를 재지정한다                            |

## 수정 범위

transcript의 필드를 두 갈래로 나눈다.

**구조 필드**는 Claude Code가 실제로 읽는 값이다. `cwd`, `wireIngestContext.*.cwd`,
`attachment.snapshot.workingDirectory` 같은 필드가 여기에 해당한다. 경로가 바뀌면 이
필드들도 반드시 따라가야 한다.

**서술 필드**는 대화 본문과 도구 출력이다. "그때 그 경로에서 이 명령을 실행했다"는 사실을
남긴 기록이므로, 고치면 과거가 사실과 달라진다. 기본적으로 손대지 않으며, 필요하면
`--rewrite-prose`로 포함시킨다.

**plan 파일은 예외다.** 과거의 기록이 아니라 앞으로 따라야 할 지시서이므로, 낡은 경로가
남아 있으면 그 경로를 따라 잘못된 작업을 하게 된다. 그래서 기본적으로 수정한다. 어떤
plan이 어느 프로젝트에 속하는지는 transcript의 `planFilePath` 구조 필드로 판정한다.
전역 plan 디렉터리를 경로 문자열로 훑으면 다른 프로젝트의 plan까지 수정하게 되기 때문이다.

손대지 않는 위치도 있다. `sessions/`, `file-history/`, `shell-snapshots/`, `session-env/`는
세션 id나 파일 해시를 키로 삼고 있어 디렉터리 이름과 무관하다. `file-history/`는 rename
이후 연결이 끊기지만, 그 때문에 동작이 잘못되지는 않는다.

## 안전장치

**백업.** 기록하기 전에 수정 대상 파일을 전부 스냅샷으로 남긴다. 같은 파일시스템이면
복사 대신 하드링크를 걸기 때문에 상태가 수 GB에 이르러도 비용이 거의 들지 않는다.

**commit barrier.** 느리지만 되돌릴 수 있는 작업을 전부 앞쪽에 모으고, 실제 교체는 뒤쪽에
짧게 배치한다. 스테이징 단계에서 실패하면 사용자에게 보이는 상태는 전혀 바뀌지 않는다.

**lock 감지.** 옛 경로에서 claude 세션이 실행 중이면 작업을 거부한다. pid 재사용을
걸러내려고 프로세스 시작 시각까지 대조한다.

**동시 수정 감지.** 재작성하는 동안 파일이 바뀌면 덮어쓰지 않고 실패한다. 실행 중인
세션이 덧붙인 줄을 말없이 잃어버리는 것보다 낫기 때문이다.

**rollback.** journal을 역순으로 재생해서 원래 상태로 복구한다. 복구 도중에 중단되어도
다시 실행하면 이어서 마무리한다.

## 종료 코드

| 코드 | 의미                                          |
| ---- | --------------------------------------------- |
| 0    | 성공                                          |
| 2    | 사용법 오류                                   |
| 10   | 계획 생성 완료. **실패가 아니다**             |
| 11   | 연결이 끊긴 상태 발견                         |
| 12   | 이관 대상 없음                                |
| 20   | 옛 경로에서 세션 실행 중                      |
| 21   | 대상 경로에 상태가 이미 존재                  |
| 22   | 전제 조건 위반. 원본 없음 또는 dst가 src 내부 |
| 30   | 실패 후 전체 복구 완료                        |
| 31   | 실패 후 복구도 실패. 수동 복구 필요           |

## 자동완성

```
eval "$(claude-mv completion zsh)"
```

명령 트리 하나에서 dispatch와 help, 자동완성이 모두 생성된다. 그래서 명령을 추가하면
자동완성도 함께 갱신된다. 후보는 셸이 CLI에 다시 질의해서 받아가므로,
`claude-mv info <TAB>`은 일반 파일이 아니라 **Claude가 알고 있는 프로젝트 경로**를 보여준다.

zsh 스크립트는 `compadd`로 후보를 등록한다. 표준 완성 절차를 거치기 때문에 fzf-tab이
별도 설정 없이 동작한다. 인자를 생략하면 fzf picker가 나타난다
(`CLAUDE_MV_PICKER=fzf|ink|none`).

## 플러그인

```
/plugin marketplace add rhseung/claude-mv
/plugin install claude-mv@rhseung
```

SessionStart hook은 현재 디렉터리에 프로젝트 기록이 없고 이름이 비슷하면서 연결이 끊긴
상태가 남아 있을 때 이를 알려준다. **알림만 보내며 자동으로 옮기지는 않는다.** 정상적인 디렉터리에서는
`existsSync`를 한 번 호출하고 끝나며 아무것도 출력하지 않는다.

`/claude-mv` 슬래시 명령도 함께 설치된다.

## 개발

```
bun install
bun run verify     format, lint, typecheck, test
bun run build
```

`plugin/hooks/session-start.mjs`는 빌드 산출물이지만 저장소에 커밋한다. 플러그인 설치가
빌드 단계 없는 `git clone`이라, 커밋하지 않으면 hook이 빠진 플러그인이 배포되기 때문이다.
CI가 소스와 산출물이 어긋나지 않았는지 검사한다.

## 라이선스

MIT
