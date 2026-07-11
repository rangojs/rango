import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

/**
 * Mid-session deploy contract: the server's build version changes while the
 * app is open in a tab.
 *
 * The chain this file locks end-to-end (each link is also unit-locked):
 *
 * 1. Every router fetch (navigation, prefetch, action) stamps the client's
 *    BOOTED version as `_rsc_v`. A server running a different build answers
 *    200 + `X-RSC-Reload` — it never feeds a new build's payload into an old
 *    client (request-classification.ts `version-mismatch`).
 * 2. The client honors X-RSC-Reload with `window.location.href` — a FULL
 *    document navigation (response-adapter.ts handleReloadHeader), which by
 *    construction drops every in-memory cache: route cache, prefetch cache,
 *    module state. (A speculative prefetch that receives the header drops the
 *    entry instead and lets the real navigation honor it —
 *    prefetch/fetch.ts.)
 * 3. At the reboot, initRangoState sees the rango state cookie's version
 *    prefix no longer matches the booted version and mints a FRESH state
 *    value (browser/rango-state.ts). Every prefetch storage key embeds the
 *    state (in-memory `rangoState\0…` keys; HTTP caches via
 *    `Vary: X-Rango-State`), so every pre-deploy prefetch is disqualified.
 *
 * Test 1 pins seam 1 over the wire; test 2 pins seam 3 in a real browser.
 * Seam 2 is client module state a live server cannot flip mid-session, so it
 * stays unit-locked (navigation-client.test.ts asserts location.href;
 * rango-state.test.ts asserts the deploy-bust mint; prefetch-cache.test.ts
 * pins the state-embedded key shapes).
 */

function runSpec(f: Fixture): void {
  test("a router fetch carrying a stale _rsc_v gets X-RSC-Reload with internal params stripped", async () => {
    const url = new URL("/", f.url("/"));
    url.searchParams.set("_rsc_partial", "true");
    url.searchParams.set("_rsc_v", "stale-build");

    const res = await fetch(url, {
      headers: { "X-Rango-State": "stale-build:1" },
    });

    expect(res.status).toBe(200);
    const reload = res.headers.get("x-rsc-reload");
    expect(reload).not.toBeNull();
    // The reload target is the clean document URL: same page, no _rsc_*
    // internals (a reload to a URL still carrying _rsc_partial would render a
    // partial payload as the document).
    const reloadUrl = new URL(reload!, url);
    expect(reloadUrl.pathname).toBe("/");
    const internal = [...reloadUrl.searchParams.keys()].filter((k) =>
      k.startsWith("_rsc"),
    );
    expect(internal).toEqual([]);
  });

  test("a state cookie from a different build is re-minted with the running build's version at boot", async ({
    page,
  }) => {
    const readState = async () => {
      const cookies = await page.context().cookies();
      return cookies.find((c) => c.name.startsWith("rango-state"));
    };

    await page.goto(f.url("/"));
    // initRangoState writes the cookie during client boot.
    await expect
      .poll(async () => (await readState())?.value ?? "")
      .toMatch(/^[^:]+:\d+$/);
    const booted = (await readState())!;
    const bootVersion = booted.value.split(":")[0]!;
    expect(bootVersion).not.toBe("stale-build");

    // Simulate the cookie a PREVIOUS build's session left in the jar.
    await page
      .context()
      .addCookies([
        { name: booted.name, value: "stale-build:1", url: f.url("/") },
      ]);
    await page.reload();

    // Boot detects the version change and mints fresh — the old state value
    // (and with it every prefetch key / Vary-keyed HTTP entry) is dead.
    await expect
      .poll(async () => (await readState())?.value ?? "")
      .not.toContain("stale-build");
    const reminted = (await readState())!;
    expect(reminted.value.split(":")[0]).toBe(bootVersion);
  });
}

test.describe("rango-state-version (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });
  runSpec(f);
});

test.describe("rango-state-version (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });
  runSpec(f);
});
