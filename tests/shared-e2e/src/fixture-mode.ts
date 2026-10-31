/**
 * Runtime half of the dev/production bucketing guard.
 *
 * The Playwright `dev` and `production` projects split suites by describe
 * title (`grep: /\(production\)/`). A build-fixture describe whose title lacks
 * `(production)` therefore runs in the dev project, where the fixture reuses
 * the project's dev `baseURL`, and passes against the dev server while its
 * production coverage silently disappears. The static guards
 * (tools/check-e2e-bucketing.mjs, tools/check-e2e-parity.mjs) cannot see a
 * describe whose mode is a variable.
 *
 * Each config tags its bucketed projects with
 * `metadata: { fixtureMode: "dev" | "build" }`. A fixture calls
 * assertFixtureModeMatchesProject from `beforeAll`, before it reads the
 * project's baseURL or spawns anything, so one check covers every helper that
 * builds a describe (`prodDescribe`, `defineSpec`, hand-written).
 *
 * A project without the tag is not bucketed (smoke, setup, a single-project
 * config) and is not checked; every project that greps on `(production)`
 * carries the tag.
 */

export type FixtureMode = "dev" | "build";

/** Key under which a bucketed Playwright project declares its mode. */
const PROJECT_MODE_METADATA_KEY = "fixtureMode";

/** What assertFixtureModeMatchesProject reads of Playwright's TestInfo. */
export interface FixtureModeTestInfo {
  titlePath: string[];
  project: { name: string; metadata: Record<string, unknown> };
}

/**
 * Throws when the fixture's `mode` disagrees with the mode its Playwright
 * project declares. The message names the describe title, the project and the
 * mode, and the fix.
 */
export function assertFixtureModeMatchesProject(
  mode: FixtureMode | undefined,
  testInfo: FixtureModeTestInfo,
): void {
  if (mode === undefined) return;
  const declared = testInfo.project.metadata[PROJECT_MODE_METADATA_KEY];
  if (declared === undefined || declared === mode) return;
  // The beforeAll hook's own entry ends the path; the file title leads it.
  const describes = testInfo.titlePath.slice(1, -1).join(" > ");
  const wantTitle =
    mode === "build"
      ? 'add "(production)" to the describe title'
      : 'remove "(production)" from the describe title';
  throw new Error(
    `E2E fixture mode mismatch: describe "${describes}" uses a ` +
      `${JSON.stringify(mode)} fixture but runs in the Playwright project ` +
      `"${testInfo.project.name}", which runs ${JSON.stringify(declared)} ` +
      "fixtures. " +
      `Projects bucket suites by describe title, so ${wantTitle}. A fixture ` +
      "created outside a describe also runs for the file's other describes: " +
      "create it inside the describe that uses it.",
  );
}
