// Runtime half of the dev/production bucketing guard.
//
// The Playwright `dev` and `production` projects split suites by describe
// title (`grep: /\(production\)/`). A build-fixture describe whose title lacks
// `(production)` therefore runs in the dev project, where the fixture reuses
// the project's dev `baseURL`, and passes against the dev server while its
// production coverage silently disappears. The static guards
// (tools/check-e2e-bucketing.mjs, tools/check-e2e-parity.mjs) cannot see a
// describe whose mode is a variable.
//
// The mode a project runs is derived from its own `grep`/`grepInvert`, so no
// config carries a tag to forget: a project that accepts a title ending in
// "(production)" and rejects one without it runs build fixtures; the reverse
// runs dev fixtures. A fixture calls assertFixtureModeMatchesProject from
// `beforeAll` (or its worker fixture), before it reads the project's baseURL
// or spawns anything, so one check covers every helper that builds a describe
// (`prodDescribe`, `defineSpec`, hand-written).
//
// The worker re-evaluates playwright.config, so `testInfo.project.grep` is a
// real RegExp (or RegExp[]) there, the same objects the runner filtered with.
//
// A project that accepts both probes (no grep: smoke, hmr, host, setup) or
// neither is not bucketed and is not checked.
//
// Plain JS with a sibling .d.ts: the no-typescript app's harness cannot
// import TypeScript sources.

const DEV_PROBE = "fixture-mode probe";
const PRODUCTION_PROBE = `${DEV_PROBE} (production)`;

function patterns(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function matchesAny(regexps, title) {
  return regexps.some((re) => {
    // A global or sticky regexp carries state across test() calls.
    re.lastIndex = 0;
    return re.test(title);
  });
}

function accepts(project, title) {
  const grep = patterns(project.grep);
  if (grep.length > 0 && !matchesAny(grep, title)) return false;
  return !matchesAny(patterns(project.grepInvert), title);
}

/** The fixture mode a project's grep buckets, or undefined when it buckets none. */
export function projectFixtureMode(project) {
  const dev = accepts(project, DEV_PROBE);
  const production = accepts(project, PRODUCTION_PROBE);
  if (production && !dev) return "build";
  if (dev && !production) return "dev";
  return undefined;
}

/**
 * Throws when the fixture's `mode` disagrees with the mode its Playwright
 * project's grep buckets. The message names the describe title, the project
 * and the mode, and the fix.
 */
export function assertFixtureModeMatchesProject(mode, testInfo) {
  if (mode === undefined) return;
  const projectMode = projectFixtureMode(testInfo.project);
  if (projectMode === undefined || projectMode === mode) return;
  // titlePath is [file, ...describes, test]; a beforeAll hook reports the
  // first test it runs for, not a title of its own (Playwright 1.63,
  // workerProcessEntry.js TestInfoImpl).
  const describes =
    testInfo.titlePath.slice(1, -1).join(" > ") || "(file level)";
  const wantTitle =
    mode === "build"
      ? 'add "(production)" to the describe title'
      : 'remove "(production)" from the describe title';
  throw new Error(
    `E2E fixture mode mismatch: describe "${describes}" uses a ` +
      `${JSON.stringify(mode)} fixture but runs in the Playwright project ` +
      `"${testInfo.project.name}", which runs ${JSON.stringify(projectMode)} ` +
      "fixtures. " +
      `Projects bucket suites by describe title, so ${wantTitle}. A fixture ` +
      "created outside a describe also runs for the file's other describes: " +
      "create it inside the describe that uses it.",
  );
}
