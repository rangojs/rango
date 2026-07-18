// Guard against docs-rot on the published skills surface under
// packages/rangojs-router/skills/ are the largest consumer-visible doc
// surface but had zero mechanical protection (no frontmatter validation, no
// check that cross-skill `/name` references resolve). A phantom reference
// (skill renamed/removed, or a typo in a `/name` cross-reference) would sit
// silently until a reader hit it.
//
// Enforced per skill directory (packages/rangojs-router/skills/<name>/):
//   1. SKILL.md exists.
//   2. Frontmatter parses (`---` fence, `name:`, `description:`), `name`
//      equals the directory basename, `description` is non-empty, and optional
//      argument hints that look like YAML collections are quoted strings.
//   3. Every backtick `/token` in a skill file's body is either a real skill
//      directory or an allowlisted non-skill URL example (route paths,
//      package subpath entries, storage-key examples, etc. that legitimately
//      look like a skill reference but aren't one).
//   4. Every relative markdown link target (`./...` or `../...`) in a skill
//      file resolves to a real file/directory on disk.
//   5. Workflow skills preserve the shared section order and ship fixture
//      artifacts: a task, an applicable setup patch, and a valid verifier script.
//
// Run: node tools/check-skills.mjs   (exits non-zero on any violation)

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const SKILLS_ROOT = path.join(REPO_ROOT, "packages/rangojs-router/skills");
const WORKFLOW_SKILLS = new Set([
  "dev-loop",
  "render-cache-adoption",
  "render-cache-optimizer",
  "stale-data-debugger",
]);
const WORKFLOW_HEADINGS = [
  "## Requires",
  "## Preflight",
  "## Scope Selection",
  "## Diagnostic Loop",
  "## Edit Rules",
  "## Browser Verification",
  "## Dev And Production Verification",
  "## Bailout Conditions",
  "## Teardown",
  "## Reference Links",
];
const FIXTURE_HEADINGS = [
  "## Broken State",
  "## Expected Diagnosis",
  "## Required Edit",
  "## Dev Verification",
  "## Production Verification",
];

// Backtick `/token` references that are NOT skill cross-references. Every
// entry was verified at its cited usage before being added: route examples,
// package subpath entries, and storage-key suffixes that appear in skill
// prose. Hold additions to the same bar — verify the usage is a legitimate
// non-skill token, then add it with a comment naming the skill(s) it comes
// from.
const URL_EXAMPLES = new Set([
  "/shop", // host-router: example mounted app
  "/en", // i18n: example locale
  "/de", // i18n: example locale
  "/gb", // i18n: example locale
  "/news", // links: example route
  "/admin", // router-setup: example basename / migrate-nextjs example route
  "/docs", // route, migrate-nextjs: example route
  "/files", // migrate-react-router: example route
  "/about", // view-transitions: example route
  "/contact", // view-transitions: example route
  "/e2e", // testing: @rangojs/router/testing/e2e subpath entry
  "/v2", // router-setup: example basename
  "/i", // intercept, prerender: intercept storage-key suffix convention
]);

const skillDirs = fs
  .readdirSync(SKILLS_ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

const violations = [];

function addViolation(file, line, message) {
  const rel = path.relative(REPO_ROOT, file);
  violations.push(`${rel}:${line}: ${message}`);
}

// --- 1 & 2: frontmatter schema ----------------------------------------------

function checkFrontmatter(skillName, skillMdAbs) {
  const text = fs.readFileSync(skillMdAbs, "utf8");
  const lines = text.split("\n");

  if (lines[0] !== "---") {
    addViolation(skillMdAbs, 1, "frontmatter must start with a `---` fence");
    return;
  }

  const closeIdx = lines.slice(1).findIndex((l) => l === "---");
  if (closeIdx === -1) {
    addViolation(skillMdAbs, 1, "frontmatter has no closing `---` fence");
    return;
  }

  const fmLines = lines.slice(1, 1 + closeIdx);
  let name;
  let nameLine = -1;
  let description;
  let descriptionLine = -1;

  fmLines.forEach((l, i) => {
    const separator = l.indexOf(":");
    if (separator !== -1) {
      const key = l.slice(0, separator).trim();
      const rawValue = l.slice(separator + 1).trim();
      const isDoubleQuoted = rawValue.startsWith('"') && rawValue.endsWith('"');
      const isSingleQuoted = rawValue.startsWith("'") && rawValue.endsWith("'");
      if (rawValue.includes(": ") && !isDoubleQuoted && !isSingleQuoted) {
        addViolation(
          skillMdAbs,
          i + 2,
          "frontmatter values containing `: ` must be quoted for valid YAML",
        );
      }
      if (
        key === "argument-hint" &&
        rawValue.startsWith("[") &&
        !isDoubleQuoted &&
        !isSingleQuoted
      ) {
        addViolation(
          skillMdAbs,
          i + 2,
          "bracketed `argument-hint` must be quoted so YAML parses it as a string",
        );
      }
    }

    const nameMatch = l.match(/^name:\s*(.*)$/);
    if (nameMatch) {
      name = nameMatch[1].trim();
      nameLine = i + 2; // +1 for the opening fence, +1 for 1-indexing
    }
    const descMatch = l.match(/^description:\s*(.*)$/);
    if (descMatch) {
      description = descMatch[1].trim();
      descriptionLine = i + 2;
    }
  });

  if (name === undefined) {
    addViolation(skillMdAbs, 1, "frontmatter is missing a `name:` key");
  } else if (name !== skillName) {
    addViolation(
      skillMdAbs,
      nameLine,
      `frontmatter name "${name}" does not match directory "${skillName}"`,
    );
  }

  if (description === undefined) {
    addViolation(skillMdAbs, 1, "frontmatter is missing a `description:` key");
  } else if (description.length === 0) {
    addViolation(skillMdAbs, descriptionLine, "description is empty");
  }
}

function checkOrderedHeadings(file, headings) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  let previous = 0;
  for (const heading of headings) {
    const index = lines.indexOf(heading);
    if (index < 0) {
      addViolation(file, 1, `missing required heading "${heading}"`);
    } else if (index < previous) {
      addViolation(file, index + 1, `heading "${heading}" is out of order`);
    }
    previous = Math.max(previous, index);
  }
}

// --- 3 & 4: cross-references and relative links -----------------------------

const SKILL_TOKEN = /`(\/[a-z][a-z0-9-]*)`/g;
const MD_LINK = /\]\(([^)]+)\)/g;

function checkBody(fileAbs, skillDirSet) {
  const text = fs.readFileSync(fileAbs, "utf8");
  const lines = text.split("\n");

  lines.forEach((lineText, idx) => {
    const lineNo = idx + 1;

    let m;
    SKILL_TOKEN.lastIndex = 0;
    while ((m = SKILL_TOKEN.exec(lineText)) !== null) {
      const token = m[1];
      const name = token.slice(1);
      if (skillDirSet.has(name) || URL_EXAMPLES.has(token)) continue;
      addViolation(
        fileAbs,
        lineNo,
        `cross-reference "${token}" does not match a skill directory and is not in URL_EXAMPLES`,
      );
    }

    MD_LINK.lastIndex = 0;
    while ((m = MD_LINK.exec(lineText)) !== null) {
      const target = m[1];
      if (!target.startsWith("./") && !target.startsWith("../")) continue;
      const cleaned = target.replace(/[#?].*$/, "");
      const resolved = path.resolve(path.dirname(fileAbs), cleaned);
      if (!fs.existsSync(resolved)) {
        addViolation(
          fileAbs,
          lineNo,
          `relative link target does not exist: ${target}`,
        );
      }
    }
  });
}

// --- run ---------------------------------------------------------------------

const skillDirSet = new Set(skillDirs);

for (const skillName of skillDirs) {
  const skillDirAbs = path.join(SKILLS_ROOT, skillName);
  const skillMdAbs = path.join(skillDirAbs, "SKILL.md");

  if (!fs.existsSync(skillMdAbs)) {
    addViolation(skillMdAbs, 1, "SKILL.md does not exist");
    continue;
  }

  checkFrontmatter(skillName, skillMdAbs);
  if (WORKFLOW_SKILLS.has(skillName)) {
    checkOrderedHeadings(skillMdAbs, WORKFLOW_HEADINGS);
    const fixtureTask = path.join(skillDirAbs, "fixtures", "task.md");
    if (!fs.existsSync(fixtureTask)) {
      addViolation(fixtureTask, 1, "workflow fixture task does not exist");
    } else {
      checkOrderedHeadings(fixtureTask, FIXTURE_HEADINGS);
    }
    for (const artifact of ["setup.patch", "verify.mjs"]) {
      const file = path.join(skillDirAbs, "fixtures", artifact);
      if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
        addViolation(file, 1, `workflow fixture ${artifact} does not exist`);
      } else {
        const command =
          artifact === "setup.patch"
            ? ["git", ["apply", "--check", file]]
            : [process.execPath, ["--check", file]];
        const result = spawnSync(command[0], command[1], {
          cwd: REPO_ROOT,
          encoding: "utf8",
        });
        if (result.status !== 0) {
          addViolation(
            file,
            1,
            `workflow fixture ${artifact} is invalid: ${(result.stderr || result.stdout).trim()}`,
          );
        }
      }
    }
  }

  const mdFiles = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.name.endsWith(".md")) {
        mdFiles.push(abs);
      }
    }
  })(skillDirAbs);

  for (const mdFile of mdFiles) {
    checkBody(mdFile, skillDirSet);
  }
}

if (violations.length > 0) {
  console.error(
    `Skills guard: ${violations.length} violation(s) in packages/rangojs-router/skills/:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v}`);
  }
  console.error(
    "\nFix the skill's frontmatter/reference, or if this is a legitimate non-skill\n" +
      "URL example, add it to URL_EXAMPLES in tools/check-skills.mjs. Workflow\n" +
      "skills must also preserve their required sections and fixture artifacts.\n",
  );
  process.exit(1);
}

console.log(
  `Skills guard: OK — ${skillDirs.length} skills, frontmatter/references and workflow fixture artifacts valid.`,
);
