import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

test.describe.configure({ mode: "serial" });

// Regression for the cached-handle serialization bug. The /cached-handles route
// is cache()-wrapped and pushes a breadcrumb whose `content` is a
// Promise<ReactNode> — the value shape JSON.stringify destroys (Promise -> {}).
// Before the fix, persisting to CFCacheStore flattened that content, so on a
// cache HIT the breadcrumb content disappeared (and rendering {} as a child threw).
// After the fix the handle map is Flight-encoded, so the content survives and
// still renders on a HIT.
//
// Runs against the real CFCacheStore in BOTH dev and production (build). The
// `(production)` tag is derived from mode === "build" so dev/prod bucketing can
// never drift (see CLAUDE.md e2e bucketing convention).
function describeCachedHandles(label: string, mode: "dev" | "build") {
  test.describe(`cached handles (${label})`, () => {
    // Dev uses an isolated server so other suites' CF cache state can't race the
    // miss -> HIT sequence this test depends on.
    const f = useFixture({
      root: ".",
      mode,
      ...(mode === "dev" ? { isolatedServer: true } : {}),
    });

    test("a Promise<ReactNode> breadcrumb content survives a cache HIT", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      const load = async () => {
        await page.goto(f.url("/cached-handles"));
        await waitForHydration(page);
        await expect(testId(page, "cached-handles-page")).toBeVisible();
        return (await testId(page, "ch-nonce").textContent()) ?? "";
      };

      // First load is a MISS: the handler runs (fresh nonce) and the response is
      // written to the cache in the background. The content renders on the miss.
      const firstNonce = await load();
      expect(firstNonce).not.toBe("");
      await expect(testId(page, "ch-crumb-content")).toHaveText(
        `content-${firstNonce}`,
      );

      // Reload until a load serves the SAME nonce — a confirmed cache HIT of the
      // first render (a fresh miss would mint a new nonce). The page body (a
      // cached segment) round-trips fine even before the fix, so this poll
      // resolves regardless and lands us on a genuine HIT.
      await expect
        .poll(load, {
          timeout: 15000,
          message:
            "Expected /cached-handles to serve a cache HIT (stable nonce)",
        })
        .toBe(firstNonce);

      // The crux: on the confirmed HIT the Promise<ReactNode> breadcrumb content
      // must still render and carry the cached nonce. Before the fix it was
      // flattened to {} by the store's JSON serialization and vanished on the HIT.
      await expect(testId(page, "ch-crumb-content")).toBeVisible();
      await expect(testId(page, "ch-crumb-content")).toHaveText(
        `content-${firstNonce}`,
      );
    });
  });
}

describeCachedHandles("dev", "dev");
describeCachedHandles("production", "build");
