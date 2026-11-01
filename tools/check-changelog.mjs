// CHANGELOG guard: a PR that changes router source (or the CLI) must change
// the "## Unreleased" section of packages/rangojs-router/CHANGELOG.md, or its
// body must carry a line "No CHANGELOG entry: <reason>". The workflow
// (.github/workflows/changelog.yml) feeds this script the changed-file list,
// the PR body, title and draft flag, and the CHANGELOG text at the base and at
// the head.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CHANGELOG_PATH = "packages/rangojs-router/CHANGELOG.md";
// The CLI lives under src/bin, so the source prefix covers it.
const SOURCE_PREFIX = "packages/rangojs-router/src/";
const TEST_FILE = /\.(?:test|rsc-test)\.[^/]+$/;
const TEST_DIR = /(?:^|\/)(?:__tests__|__augment-tests__|__mocks__)\//;
const OPT_OUT = /^[ \t]*No CHANGELOG entry:[ \t]*(\S.*)$/im;

/** True for a file whose change a consumer of the package can see. */
export function isConsumerSource(file) {
  if (!file.startsWith(SOURCE_PREFIX)) return false;
  return !TEST_DIR.test(file) && !TEST_FILE.test(file);
}

/** The text between "## Unreleased" and the next "## " heading, or null. */
export function unreleasedSection(changelog) {
  const lines = (changelog ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Unreleased\s*$/i.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
}

/** The reason given on a "No CHANGELOG entry: <reason>" line, or null. */
export function optOutReason(body) {
  const m = OPT_OUT.exec(body ?? "");
  return m ? m[1].trim() : null;
}

/** Returns { ok, exempt, sources, problems }. */
export function evaluate({
  changedFiles,
  body,
  title,
  draft,
  baseChangelog,
  headChangelog,
}) {
  if (draft) return { ok: true, exempt: "draft", sources: [], problems: [] };
  if (/^chore\(release\)/i.test(title ?? "")) {
    return { ok: true, exempt: "release", sources: [], problems: [] };
  }
  const sources = changedFiles.filter(isConsumerSource);
  if (sources.length === 0) {
    return { ok: true, exempt: null, sources, problems: [] };
  }
  const before = unreleasedSection(baseChangelog);
  const after = unreleasedSection(headChangelog);
  if (after !== null && after !== "" && after !== before) {
    return { ok: true, exempt: null, sources, problems: [] };
  }
  if (optOutReason(body) !== null) {
    return { ok: true, exempt: null, sources, problems: [] };
  }
  return {
    ok: false,
    exempt: null,
    sources,
    problems: [
      `${CHANGELOG_PATH} has no new entry under "## Unreleased", and the PR body has no "No CHANGELOG entry: <reason>" line with a reason`,
    ],
  };
}

function main() {
  const [inputPath] = process.argv.slice(2);
  if (!inputPath) {
    console.error("usage: check-changelog.mjs <input.json>");
    process.exit(2);
  }
  const result = evaluate(JSON.parse(readFileSync(inputPath, "utf8")));
  if (result.exempt) {
    console.log(`changelog: exempt (${result.exempt}).`);
    return;
  }
  if (result.sources.length === 0) {
    console.log("changelog: no consumer-visible source file changed.");
    return;
  }
  if (result.ok) {
    console.log("changelog: entry or opt-out present.");
    return;
  }
  console.error("changelog: router source changed:");
  for (const f of result.sources) console.error(`  ${f}`);
  for (const p of result.problems) console.error(`changelog: ${p}`);
  console.error(
    'Add the entry in the "### Kind: outcome" + Before/Now style, or say "No CHANGELOG entry: <why>" in the PR body.',
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
