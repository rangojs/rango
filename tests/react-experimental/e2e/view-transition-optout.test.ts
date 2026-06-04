import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
  expectNoReload,
  installVtRecorder,
  vtCount,
} from "./helper";

/**
 * View-transition boundary opt-out (transition({ viewTransition: false })).
 *
 * The router-owned <ViewTransition> boundary is the only thing the flag
 * toggles; navigation driving (the startTransition wrap) and content-hold are
 * unaffected. We assert the boundary's presence by recording calls to
 * document.startViewTransition (installVtRecorder) — React only calls it when a
 * <ViewTransition> in the committed tree actually enters/exits/updates:
 *
 *   - /vt-auto-*  (transition({}))            -> router boundary -> it fires.
 *   - /vt-off-*   (transition({ vt:false }))  -> no boundary, no consumer VT
 *                                                -> it does NOT fire.
 *   - /vt-user-*  (transition({ vt:false }) + a consumer-placed
 *                 <ViewTransition name>)       -> no router boundary, but the
 *                                                consumer morph drives it ->
 *                                                it fires (driving survived).
 */
function describeOptout(label: "dev" | "production", mode: "dev" | "build") {
  test.describe(`view-transition boundary opt-out (${label})`, () => {
    test.describe.configure({ mode: "serial" });

    const f = useFixture({ root: ".", mode });

    test("auto: router boundary fires document.startViewTransition", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/vt-auto-x"));
      await waitForHydration(page);
      await expect(testId(page, "vt-auto-x-page")).toBeVisible();

      // Confirm the browser actually supports the API we are asserting on, so a
      // missing API surfaces as a clear failure rather than a silent 0.
      expect(
        await page.evaluate(() => typeof document.startViewTransition),
      ).toBe("function");

      await installVtRecorder(page);

      await using __ = await expectNoReload(page);
      await testId(page, "nav-vt-auto-y").click();
      await expect(page).toHaveURL(/\/vt-auto-y/);
      await expect(testId(page, "vt-auto-y-page")).toBeVisible();

      expect(await vtCount(page)).toBeGreaterThanOrEqual(1);
    });

    test("viewTransition:false: no router boundary, no view transition fires", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/vt-off-x"));
      await waitForHydration(page);
      await expect(testId(page, "vt-off-x-page")).toBeVisible();

      await installVtRecorder(page);

      await using __ = await expectNoReload(page);
      await testId(page, "nav-vt-off-y").click();
      await expect(page).toHaveURL(/\/vt-off-y/);
      await expect(testId(page, "vt-off-y-page")).toBeVisible();

      // React commits the swap inside the startViewTransition callback, so by
      // the time the destination is visible the call (if any) has happened.
      // With no router boundary and no consumer <ViewTransition>, none fires.
      expect(await vtCount(page)).toBe(0);
    });

    test("viewTransition:false: a consumer-placed <ViewTransition> still animates", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/vt-user-x"));
      await waitForHydration(page);
      await expect(testId(page, "vt-user-x-page")).toBeVisible();

      await installVtRecorder(page);

      await using __ = await expectNoReload(page);
      await testId(page, "nav-vt-user-y").click();
      await expect(page).toHaveURL(/\/vt-user-y/);
      await expect(testId(page, "vt-user-y-page")).toBeVisible();

      // Driving survives the boundary opt-out: the consumer's named morph
      // (shared across the route swap) triggers the view transition.
      expect(await vtCount(page)).toBeGreaterThanOrEqual(1);
    });
  });
}

describeOptout("dev", "dev");
describeOptout("production", "build");

/**
 * Global default: createRouter({ viewTransition: false }).
 *
 * Builds/serves the app with VITE_RANGO_VT=false so the router is created with
 * the global opt-out. This exercises the full wiring the per-route tests don't:
 * createRouter option -> segmentDeps -> segment resolution -> serialized
 * segment -> client render gate. A route with a bare transition({}) inherits
 * the global (no boundary); a route with an explicit transition({
 * viewTransition: "auto" }) overrides it (boundary fires).
 */
function describeGlobalDefault(
  label: "dev" | "production",
  mode: "dev" | "build",
) {
  test.describe(`global viewTransition:false default (${label})`, () => {
    test.describe.configure({ mode: "serial" });

    const f = useFixture({
      root: ".",
      mode,
      cliOptions: { env: { ...process.env, VITE_RANGO_VT: "false" } },
    });

    test("global false suppresses the boundary on a bare transition({}) route", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/vt-auto-x"));
      await waitForHydration(page);
      await expect(testId(page, "vt-auto-x-page")).toBeVisible();

      await installVtRecorder(page);

      await using __ = await expectNoReload(page);
      await testId(page, "nav-vt-auto-y").click();
      await expect(page).toHaveURL(/\/vt-auto-y/);
      await expect(testId(page, "vt-auto-y-page")).toBeVisible();

      // /vt-auto-* uses transition({}) with no per-route flag, so the global
      // default decides: with viewTransition:false, no router boundary fires.
      expect(await vtCount(page)).toBe(0);
    });

    test("per-route viewTransition:'auto' overrides the global false", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/vt-force-auto-x"));
      await waitForHydration(page);
      await expect(testId(page, "vt-force-auto-x-page")).toBeVisible();

      await installVtRecorder(page);

      await using __ = await expectNoReload(page);
      await testId(page, "nav-vt-force-auto-y").click();
      await expect(page).toHaveURL(/\/vt-force-auto-y/);
      await expect(testId(page, "vt-force-auto-y-page")).toBeVisible();

      // Explicit transition({ viewTransition: "auto" }) beats the global false.
      expect(await vtCount(page)).toBeGreaterThanOrEqual(1);
    });
  });
}

describeGlobalDefault("dev", "dev");
describeGlobalDefault("production", "build");
