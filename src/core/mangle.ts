/**
 * Claude Code 가 프로젝트 경로를 디렉터리 이름으로 바꾸는 규칙.
 * claude-code v2.1.267 바이너리에서 추출한 구현을 그대로 옮긴 것이다.
 */

/** mangling 결과가 이 길이를 넘으면 잘라내고 해시를 붙인다. */
const MANGLE_MAX = 200;

/**
 * `h = h * 31 + c` 를 int32 로 감싸는 고전적인 문자열 해시.
 * `(h << 5) - h` 가 `h * 31` 이다. 200 자가 넘는 경로에만 쓰인다.
 */
export function mangleHash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  }
  return h;
}

/**
 * 절대 경로를 `~/.claude/projects/` 아래의 디렉터리 이름으로 바꾼다.
 *
 * 주의할 점이 셋 있다.
 *
 * 1. 치환 단위가 UTF-16 code unit 이다. 한글 한 글자가 대시 하나가 되고, NFC 로 쓴 "한" 과
 *    NFD 로 쓴 "하"+jamo 는 서로 다른 이름이 된다. 그래서 입력 문자열의 유니코드 정규화 형태를
 *    임의로 바꾸면 안 된다.
 * 2. 대소문자를 보존한다. macOS 처럼 대소문자를 구분하지 않는 파일시스템에서도
 *    `/a/Proj` 와 `/a/proj` 는 서로 다른 디렉터리 이름이 된다.
 * 3. 길이 판정과 자르기가 전부 code unit 기준이라 서로게이트 쌍 한가운데서 잘릴 수 있다.
 *    원본 구현이 그렇게 동작하므로 여기서도 똑같이 둔다.
 */
export function mangle(absolutePath: string): string {
  const replaced = absolutePath.replace(/[^a-zA-Z0-9]/g, '-');
  if (replaced.length <= MANGLE_MAX) return replaced;

  // 해시 인자는 치환된 문자열이 아니라 원본 경로다. 여기를 바꾸면 이름이 통째로 달라진다.
  return `${replaced.slice(0, MANGLE_MAX)}-${Math.abs(mangleHash(absolutePath)).toString(36)}`;
}

/**
 * 두 경로가 같은 mangled 이름으로 접히는지.
 *
 * mangling 은 `/` 와 `.` 과 `-` 를 모두 대시 하나로 만들기 때문에 되돌릴 수 없다.
 * `/a/b-c` 와 `/a/b/c` 가 같은 이름이 된다. 그래서 디렉터리 이름만 보고 원래 경로를
 * 복원하려 들면 안 되고, 안에 든 트랜스크립트의 `cwd` 를 읽어야 한다.
 */
export function collides(a: string, b: string): boolean {
  return a !== b && mangle(a) === mangle(b);
}
