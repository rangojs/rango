import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * Node preset dev: an RSC runner full reload lands while a GET runs. The
 * request's handler (urls/dev-reload-split.tsx) loads a probe that asks for
 * the dep optimizer's reload and resumes after the runner's clear, so what it
 * imports next is a fresh module copy whose request context is empty. The
 * generated RSC entry hands the request to the entry the reload re-evaluated
 * (router/dev-reload-handoff.ts), where it runs whole on one module set.
 *
 * Dev only: a build has no module runner. Isolated server: the probe fires
 * once per server.
 */
const PROBE_LOG = "[rango-e2e] dev-reload-split: full reload sent";

test.describe("dev-reload-handoff", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
    cliOptions: { env: { RANGO_E2E_DEV_RELOAD_SPLIT: "1" } },
  });

  test("a document GET the reload splits answers 200 from the re-evaluated entry", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    using _ = expectNoPageError(page);

    const response = await page.goto(f.url("/dev-reload-split"));
    expect(f.proc().stdout()).toContain(PROBE_LOG);
    expect(response?.status()).toBe(200);
    await waitForHydration(page);
    await expect(testId(page, "dev-reload-split")).toHaveText(
      "/dev-reload-split",
    );
  });
});
