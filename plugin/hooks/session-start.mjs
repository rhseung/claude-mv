// src/hook/session-start.ts
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

// src/core/mangle.ts
var MANGLE_MAX = 200;
function mangleHash(input) {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h << 5) - h + input.charCodeAt(i) | 0;
  }
  return h;
}
function mangle(absolutePath) {
  const replaced = absolutePath.replace(/[^a-zA-Z0-9]/g, "-");
  if (replaced.length <= MANGLE_MAX) return replaced;
  return `${replaced.slice(0, MANGLE_MAX)}-${Math.abs(mangleHash(absolutePath)).toString(36)}`;
}

// src/hook/session-start.ts
var BUDGET_MS = 60;
var THROTTLE_MS = 12 * 60 * 60 * 1e3;
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
function claudeHome() {
  return (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")).normalize("NFC");
}
function configPath(home) {
  const preferred = join(home, ".config.json");
  if (existsSync(preferred)) return preferred;
  return join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");
}
function knownProjects(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Object.keys(parsed.projects ?? {});
  } catch {
    return [];
  }
}
function basename(path) {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}
function dirname(path) {
  const parts = path.split(/[/\\]/);
  parts.pop();
  return parts.join("/") || "/";
}
function pickCandidate(known, cwd) {
  const scored = known.map((path) => {
    let score = 0;
    if (dirname(path) === dirname(cwd)) score += 2;
    if (basename(path) === basename(cwd)) score += 2;
    return { path, score };
  }).filter((c) => c.score >= 2).sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (!best) return null;
  if (second && second.score === best.score) return null;
  return best.path;
}
function warnedRecently(cwd) {
  const stamp = join(tmpdir(), `claude-mv-warned-${Buffer.from(cwd).toString("base64url")}`);
  try {
    if (Date.now() - statSync(stamp).mtimeMs < THROTTLE_MS) return true;
    utimesSync(stamp, /* @__PURE__ */ new Date(), /* @__PURE__ */ new Date());
    return false;
  } catch {
    try {
      mkdirSync(tmpdir(), { recursive: true });
      writeFileSync(stamp, "");
    } catch {
    }
    return false;
  }
}
async function main() {
  const startedAt = Date.now();
  const input = JSON.parse(await readStdin());
  const cwd = input.cwd;
  if (!cwd) return;
  const home = claudeHome();
  const projectsDir = join(home, "projects");
  if (existsSync(join(projectsDir, mangle(cwd)))) return;
  if (warnedRecently(cwd)) return;
  const candidate = pickCandidate(knownProjects(configPath(home)), cwd);
  if (!candidate) return;
  if (existsSync(candidate)) return;
  if (!existsSync(join(projectsDir, mangle(candidate)))) return;
  if (Date.now() - startedAt > BUDGET_MS) return;
  process.stdout.write(
    JSON.stringify({
      systemMessage: [
        "claude-mv: \uC774 \uB514\uB809\uD130\uB9AC\uC5D0\uB294 Claude \uD504\uB85C\uC81D\uD2B8 \uAE30\uB85D\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.",
        `  ${candidate} \uC758 \uAE30\uB85D\uC774 \uB0A8\uC544 \uC788\uACE0, \uADF8 \uACBD\uB85C\uB294 \uC9C0\uAE08 \uC5C6\uC2B5\uB2C8\uB2E4.`,
        `  \uC62E\uAE34 \uAC83\uC774\uB77C\uBA74:  npx @rhseung/claude-mv --state-only "${candidate}" "${cwd}"`,
        "  \uBA3C\uC800 \uD655\uC778\uD558\uB824\uBA74:  npx @rhseung/claude-mv doctor"
      ].join("\n")
    })
  );
}
main().catch(() => {
});
