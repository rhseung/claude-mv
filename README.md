# claude-mv

프로젝트 디렉터리를 옮기면 Claude Code 의 세션 기록이 끊긴다. 상태가 **절대 경로를 키로**
저장되기 때문이다. 이 도구는 디렉터리와 상태를 같이 옮긴다.

## 문제

`mv` 한 번으로 아래가 전부 고아가 된다.

```
~/.claude/projects/-Users-me-dev-old-name/      세션 기록(transcript)
~/.claude.json  projects["/Users/me/dev/old-name"]
~/.claude/history.jsonl  의 project 필드
~/Library/Caches/claude-cli-nodejs/-Users-me-dev-old-name/   MCP 로그
~/.claude/plans/*.md  안의 경로 문자열
```

디렉터리 이름은 경로에서 영숫자가 아닌 문자를 전부 `-` 로 바꾼 것이다. 이 변환은
**되돌릴 수 없다** - `/a/b-c` 와 `/a/b/c` 가 같은 이름이 된다. 그래서 디렉터리 이름만 보고
원래 경로를 알아낼 수는 없고, 안에 든 트랜스크립트의 `cwd` 를 읽어야 한다.

## 설치

```
npx @rhseung/claude-mv doctor
```

```
bun install -g @rhseung/claude-mv
npm install -g @rhseung/claude-mv
```

## 사용법

먼저 계획을 본다. 아무것도 쓰지 않는다.

```
claude-mv --dry-run ~/dev/old-name ~/dev/new-name
```

괜찮으면 실행한다.

```
claude-mv ~/dev/old-name ~/dev/new-name
```

이미 손으로 옮겼다면 상태만 따라 옮긴다.

```
claude-mv --state-only ~/dev/old-name ~/dev/new-name
```

## 명령

| 명령                | 하는 일                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `mv <src> <dst>`    | 디렉터리와 상태를 함께 옮긴다. 첫 인자가 명령 이름이 아니면 이게 기본이다 |
| `ls`                | Claude 가 아는 프로젝트를 전부 보여준다                                   |
| `info <경로>`       | 한 프로젝트의 상태를 자세히 본다                                          |
| `doctor`            | 고아가 된 상태를 찾고 어디로 갔는지 추측한다                              |
| `rm <경로>`         | 한 프로젝트의 Claude 상태를 지운다 (백업 후)                              |
| `merge <from> <to>` | 두 프로젝트 디렉터리를 합친다                                             |
| `backup [경로]`     | 이동 없이 스냅샷만 뜬다                                                   |
| `rollback [id]`     | 백업 목록을 보거나 되돌린다                                               |
| `export <경로>`     | 상태를 tarball 로 내보낸다                                                |
| `import <파일>`     | tarball 에서 들여온다. `--to` 를 주면 이어서 이관한다                     |
| `completion <셸>`   | 자동완성 스크립트를 출력한다                                              |

| 플래그                 | 뜻                                                  |
| ---------------------- | --------------------------------------------------- |
| `-n, --dry-run`        | 계획만. 아무것도 쓰지 않는다                        |
| `-y, --yes`            | 확인 프롬프트를 건너뛴다                            |
| `-f, --force`          | lock 과 상태 충돌을 경고로 낮춘다                   |
| `--state-only`         | 디렉터리는 두고 상태만 옮긴다                       |
| `--rewrite-prose`      | 대화 본문에 박힌 경로까지 바꾼다                    |
| `--no-backup`          | 백업을 만들지 않는다 (rollback 불가)                |
| `--json`               | 기계용 출력. 진행은 stderr, 결과 객체 하나는 stdout |
| `--claude-home <경로>` | `~/.claude` 위치를 재정의한다                       |

## 무엇을 고치고 무엇을 두는가

트랜스크립트의 필드를 두 갈래로 나눈다.

**구조 필드**는 Claude 가 실제로 읽는 값이다. `cwd`, `wireIngestContext.*.cwd`,
`attachment.snapshot.workingDirectory` 같은 것들. 경로가 바뀌면 반드시 따라가야 한다.

**서술 필드**는 대화 본문과 툴 출력이다. "그때 그 경로에서 이 명령을 실행했다" 는 기록이라
고치면 과거가 거짓이 된다. 기본으로 두고, 필요하면 `--rewrite-prose` 로 켠다.

**플랜 파일은 예외다.** 과거의 기록이 아니라 앞으로 따라야 할 지시서이므로, 낡은 경로가
남으면 그대로 틀린 일을 하게 된다. 기본으로 고친다. 어떤 플랜이 어느 프로젝트 것인지는
트랜스크립트의 `planFilePath` 구조 필드로 판정한다 - 전역 플랜 디렉터리를 경로 문자열로
훑으면 남의 플랜을 건드리게 된다.

손대지 않는 곳도 있다. `sessions/`, `file-history/`, `shell-snapshots/`, `session-env/` 는
세션 id 나 파일 해시로 키가 잡혀 있어 디렉터리 이름과 무관하다. `file-history/` 는 rename
후 조용히 고아가 되지만 깨지는 것은 없다.

## 안전장치

**백업.** 쓰기 전에 건드릴 파일을 전부 스냅샷으로 남긴다. 같은 파일시스템이면 복사 대신
하드링크라 수 GB 짜리 상태도 비용이 거의 없다.

**커밋 장벽.** 느리고 되돌릴 수 있는 작업을 전부 앞으로 몰고 실제 교체는 뒤에 짧게 모은다.
스테이징 단계에서 실패하면 사용자 눈에 보이는 것은 아무것도 바뀌지 않는다.

**lock 감지.** 옛 경로에서 claude 세션이 돌고 있으면 거부한다. pid 재사용을 걸러내려고
프로세스 시작 시각까지 대조한다.

**동시 수정 감지.** 재작성하는 동안 파일이 바뀌면 덮어쓰지 않고 실패한다. 라이브 세션이
덧붙인 줄을 조용히 잃는 것보다 낫다.

**rollback.** 저널을 역순으로 재생해서 원래대로 돌린다. 되돌리는 도중에 죽어도 다시
실행하면 이어서 끝낸다.

## 종료 코드

| 코드 | 뜻                                                 |
| ---- | -------------------------------------------------- |
| 0    | 성공                                               |
| 2    | 사용법 오류                                        |
| 10   | `--dry-run` 이 계획을 만들었다. **실패가 아니다**  |
| 11   | `doctor`/`ls` 가 고아를 찾았다                     |
| 12   | 옮길 것이 없다                                     |
| 20   | 옛 경로에서 세션이 돌고 있다                       |
| 21   | 대상 쪽에 이미 상태가 있다                         |
| 22   | 전제 조건 위반 (원본 없음, dst 가 src 안)          |
| 30   | 실패했고 전부 되돌렸다                             |
| 31   | 실패했고 되돌리기도 실패했다. 손으로 복구해야 한다 |

## 자동완성

```
eval "$(claude-mv completion zsh)"
```

명령 트리 하나에서 dispatch, help, 자동완성이 전부 나온다. 명령을 추가하면 자동완성이
따라온다. 후보는 셸이 CLI 에 되물어서 받아가므로 `claude-mv info <TAB>` 은 일반 파일이
아니라 **Claude 가 아는 프로젝트 경로**를 보여준다.

zsh 스크립트는 `compadd` 로 후보를 넣는다. 표준 완성 경로를 타기 때문에 fzf-tab 이
아무 설정 없이 걸린다. 인자를 생략하면 fzf 피커가 뜬다 (`CLAUDE_MV_PICKER=fzf|ink|none`).

## 플러그인

```
/plugin marketplace add rhseung/claude-mv
/plugin install claude-mv@rhseung
```

SessionStart 훅이 지금 디렉터리에 프로젝트 기록이 없는데 비슷한 이름의 고아 상태가 있으면
알려준다. **경고만 한다. 자동으로 옮기지 않는다.** 정상 경로에서는 `existsSync` 한 번으로
끝나고 아무것도 출력하지 않는다.

`/claude-mv` 슬래시 명령도 같이 설치된다.

## 개발

```
bun install
bun run verify     format, lint, typecheck, test
bun run build
```

`plugin/hooks/session-start.mjs` 는 빌드 산출물인데 커밋한다. 플러그인 설치는 빌드 단계가
없는 `git clone` 이라, 무시하면 훅이 빠진 플러그인이 배포된다. CI 가 소스와의 동기화를
검사한다.

## 라이선스

MIT
