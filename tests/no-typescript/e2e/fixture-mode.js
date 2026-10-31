// Runtime half of the dev/production bucketing guard. Mirrors
// tests/shared-e2e/src/fixture-mode.ts (documented there); this app's
// harness stays plain JS and cannot import that TypeScript module.
//
// Each bucketed project in playwright.config.js declares
// `metadata: { fixtureMode: "dev" | "build" }`. A describe whose fixture mode
// disagrees with its project's runs against the wrong server, so throw.

export function assertFixtureModeMatchesProject(mode, testInfo) {
  if (mode === undefined) return;
  const declared = testInfo.project.metadata.fixtureMode;
  if (declared === undefined || declared === mode) return;
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
