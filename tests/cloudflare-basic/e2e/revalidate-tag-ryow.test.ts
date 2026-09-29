import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// Issue #973: revalidateTag() does not wait for CFCacheStore's KV marker
// write, so a server action that ran it and then re-rendered read the
// entries its own invalidation covered until the put landed. Local workerd KV
// lands the put before the re-render reads the marker, so /ryow-action caches
// its loader on a store that holds marker puts for SLOW_MARKER_PUT_MS
// (src/slow-marker-store.ts), as a slow KV put would on a deployed worker.
// The unit suites pin the same race with a mocked KV
// (packages/rangojs-router/src/cache/cf/__tests__/cf-cache-store-tags.test.ts).

// Serial: each run owns its loader entry and tag through a unique probe, but
// the marker writes share the KV namespace.
test.describe.configure({ mode: "serial" });

function uniqueProbe(): string {
  return `ryow-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function describeRevalidateTagRyow(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";

  test.describe(`revalidateTag read-your-own-writes (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    test("a server action's revalidateTag() re-runs the cached loader in its own response while the KV marker write is held", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url(`/ryow-action/${uniqueProbe()}`));
      await waitForHydration(page);
      const first = await testId(page, "ryow-loaded-at").textContent();
      expect(first).toBeTruthy();

      // The loader entry is written in the background: reload until a HIT
      // repeats the value.
      await expect(async () => {
        await page.reload();
        await waitForHydration(page);
        await expect(testId(page, "ryow-loaded-at")).toHaveText(first!);
      }).toPass({ timeout: 15000 });

      // Nothing re-renders the page after the action response, so a stale
      // value here stays stale.
      await testId(page, "ryow-revalidate").click();
      await expect(testId(page, "ryow-loaded-at")).not.toHaveText(first!);
    });
  });
}

describeRevalidateTagRyow("dev");
describeRevalidateTagRyow("build");
