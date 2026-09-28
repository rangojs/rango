import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// Issue #941: the stores keep per-isolate memos of PPR shells and tag markers,
// which another isolate can hold past an updateTag(). A request that ran
// updateTag()/revalidateTag() sets the fresh-reads cookie, and the same user's
// requests carrying it read past both memos on every isolate. One local worker
// is one isolate, where the invalidation's write-through already keeps the
// memos correct, so this suite pins what the cookie itself does: its
// attributes, a fresh reload, and HITs that carry it reading the store
// (`hit l1`, `memo=bypass … fresh-reads`) while a request without it is served
// from the shell memo. The cross-isolate behavior is unit-pinned
// (src/cache/__tests__/shell-memo-contract.test.ts).

// Serial: the capture is a background task and the invalidation writes shared
// KV markers. Each run owns its shell key and tag through a unique probe.
test.describe.configure({ mode: "serial" });

const HTML_HEADERS = { Accept: "text/html" };

function uniqueProbe(): string {
  return `fr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function describeFreshReads(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";

  test.describe(`ppr fresh-reads cookie (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    test("a server action's updateTag() sets the fresh-reads cookie; the reload is fresh and HITs carrying it read past the memos", async ({
      page,
      request,
    }) => {
      using _ = expectNoPageError(page);
      const url = f.url(
        `/ppr-fresh-reads?probe=${uniqueProbe()}&__perf_debug=1`,
      );

      // 1. Warm the tagged shell to a HIT, then open it in the browser.
      await expect(async () => {
        const res = await request.get(url, { headers: HTML_HEADERS });
        expect(res.headers()["x-rango-shell"]).toBe("HIT");
      }).toPass({ timeout: 20000 });
      const hit = await page.goto(url);
      expect(hit?.headers()["x-rango-shell"]).toBe("HIT");
      await waitForHydration(page);
      const before = await testId(page, "fresh-reads-token").textContent();

      // 2. The server action runs updateTag(); its response sets the cookie.
      await testId(page, "fresh-reads-invalidate").click();
      await expect(testId(page, "fresh-reads-invalidate")).toHaveAttribute(
        "data-done",
        "true",
      );
      const fresh = (await page.context().cookies()).find(
        (cookie) => cookie.name === "rango-state-fresh",
      );
      expect(fresh).toMatchObject({
        value: "1",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        secure: false,
      });
      // Max-Age: the store's longest memo staleness plus 1 s (CFCacheStore
      // with KV: the 10 s marker max-stale cap, so 11 s).
      const remaining = fresh!.expires - Date.now() / 1000;
      expect(remaining).toBeGreaterThan(6);
      expect(remaining).toBeLessThanOrEqual(12);

      // 3. The reload carries the cookie: the invalidated shell MISSes and
      // renders anew.
      const reload = await page.reload();
      expect(reload?.headers()["x-rango-shell"]).toBe("MISS");
      await waitForHydration(page);
      await expect(testId(page, "fresh-reads-token")).not.toHaveText(before!);

      // 4. Once the recapture lands, a HIT carrying the cookie reads the store
      // (not the shell memo) and bypasses the marker memo. The header is set
      // explicitly so a slow recapture cannot outlive the cookie's Max-Age.
      const cookie = `${fresh!.name}=1`;
      await expect(async () => {
        const res = await request.get(url, {
          headers: { ...HTML_HEADERS, cookie },
        });
        expect(res.headers()["x-rango-shell"]).toBe("HIT");
      }).toPass({ timeout: 20000 });
      const bypass = await request.get(url, {
        headers: { ...HTML_HEADERS, cookie },
      });
      expect(bypass.headers()["x-rango-shell"]).toBe("HIT");
      const bypassTiming = bypass.headers()["server-timing"] ?? "";
      expect(bypassTiming).toMatch(/ppr-shell-read;dur=[\d.]+;desc="hit l1"/);
      expect(bypassTiming).toMatch(
        /d1-ppr-shell-marker;dur=[\d.]+;desc="tags=\d+ parallel commit-wait=[\d.]+ms memo=bypass[^"]* fresh-reads"/,
      );

      // 5. A request without the cookie is served from the shell memo.
      const plain = await request.get(url, { headers: HTML_HEADERS });
      expect(plain.headers()["x-rango-shell"]).toBe("HIT");
      expect(plain.headers()["server-timing"] ?? "").toMatch(
        /ppr-shell-read;dur=[\d.]+;desc="hit memo"/,
      );
    });
  });
}

describeFreshReads("dev");
describeFreshReads("build");
