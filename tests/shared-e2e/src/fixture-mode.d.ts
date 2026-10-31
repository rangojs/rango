export type FixtureMode = "dev" | "build";

/** What the check reads of a Playwright project (`testInfo.project`). */
export interface FixtureModeProject {
  name: string;
  grep: RegExp | RegExp[];
  grepInvert?: RegExp | RegExp[] | null;
}

/** What assertFixtureModeMatchesProject reads of Playwright's TestInfo. */
export interface FixtureModeTestInfo {
  titlePath: string[];
  project: FixtureModeProject;
}

/** The fixture mode a project's grep buckets, or undefined when it buckets none. */
export function projectFixtureMode(
  project: Pick<FixtureModeProject, "grep" | "grepInvert">,
): FixtureMode | undefined;

/**
 * Throws when the fixture's `mode` disagrees with the mode its Playwright
 * project's grep buckets.
 */
export function assertFixtureModeMatchesProject(
  mode: FixtureMode | undefined,
  testInfo: FixtureModeTestInfo,
): void;
