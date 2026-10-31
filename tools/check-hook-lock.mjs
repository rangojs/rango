// Hook-lock guard: a PR that touches a file listed in tools/hook-lock.json
// fails unless it carries the approval label AND its body links the hooks
// design. The workflow (.github/workflows/hook-lock.yml) feeds this script the
// changed-file list, the current labels and the PR body.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Glob to RegExp: `*` stays inside a path segment, `**` crosses segments. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function lockedPatterns(config) {
  return [...config.commitFiles, ...config.lockTests, ...config.guardFiles].map(
    (glob) => ({ glob, re: globToRegExp(glob) }),
  );
}

/** Files from `changedFiles` that match a locked pattern. */
export function matchLocked(changedFiles, config) {
  const patterns = lockedPatterns(config);
  return changedFiles.filter((f) => patterns.some((p) => p.re.test(f)));
}

export function bodyLinksDesign(body, config) {
  const ids = config.design.map((id) =>
    id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(`\\b(${ids.join("|")})\\b`).test(body ?? "");
}

/** Returns { ok, locked, problems }. */
export function evaluate({ changedFiles, labels, body }, config) {
  const locked = matchLocked(changedFiles, config);
  if (locked.length === 0) return { ok: true, locked, problems: [] };
  const problems = [];
  if (!labels.includes(config.label)) {
    problems.push(`missing label "${config.label}" (set by the owner)`);
  }
  if (!bodyLinksDesign(body, config)) {
    problems.push(
      `PR body must link the hooks design (${config.design.join(" or ")})`,
    );
  }
  return { ok: problems.length === 0, locked, problems };
}

function main() {
  const [inputPath] = process.argv.slice(2);
  if (!inputPath) {
    console.error("usage: check-hook-lock.mjs <input.json>");
    process.exit(2);
  }
  const config = JSON.parse(
    readFileSync(new URL("./hook-lock.json", import.meta.url), "utf8"),
  );
  const input = JSON.parse(readFileSync(inputPath, "utf8"));
  const result = evaluate(input, config);
  if (result.locked.length === 0) {
    console.log("hook-lock: no locked file changed.");
    return;
  }
  console.log("hook-lock: locked files changed:");
  for (const f of result.locked) console.log(`  ${f}`);
  if (result.ok) {
    console.log("hook-lock: approved (label present, design linked).");
    return;
  }
  for (const p of result.problems) console.error(`hook-lock: ${p}`);
  console.error(
    "Hook commit behavior changes need a big-picture design (AGENTS.md Hard rule 10).",
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
