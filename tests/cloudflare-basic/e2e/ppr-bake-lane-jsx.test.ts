import { expect, test } from "@playwright/test";
import { guardHydrationErrors } from "@shared/e2e";
import { assertShellStatus } from "@rangojs/router/testing/e2e";
import { useFixture, type Fixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

// Issue #942: an ssr:false loader value carrying JSX (loaders/ppr-jsx.tsx).
// In dev the route stayed x-rango-shell: MISS.

const HTML_HEADERS = { Accept: "text/html" };
const LIVE_VALUE = /live run \d+/;
const REVIEWS_VALUE = /reviews run \d+/;

function defineBakeLaneJsxTests(f: Fixture) {
  test("ssr:false loader value with JSX: HITs, bakes the elements, streams the promises inside JSX, hydrates cleanly", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    using __ = guardHydrationErrors(page);
    const url = f.url(`/ppr-jsx?run=${crypto.randomUUID()}`);

    let html = "";
    await expect(async () => {
      const res = await page.request.get(url, { headers: HTML_HEADERS });
      expect(res.status()).toBe(200);
      assertShellStatus(
        {
          headers: new Headers({
            "x-rango-shell": res.headers()["x-rango-shell"] ?? "",
          }),
        },
        "HIT",
      );
      html = await res.text();
    }).toPass({ timeout: 30_000 });

    const preludeEnd = html.indexOf("</html>");
    expect(preludeEnd).toBeGreaterThan(-1);
    const prelude = html.slice(0, preludeEnd);
    const resumed = html.slice(preludeEnd);
    expect(prelude).toContain("JSX from a bake-lane loader");
    expect(prelude).toContain("Related to p1");
    const captured = prelude.match(/captured in run \d+/)?.[0];
    expect(captured).toBeDefined();
    expect(prelude).toContain("live pending...");
    expect(prelude).toContain("reviews pending...");
    expect(prelude).not.toMatch(LIVE_VALUE);
    expect(prelude).not.toMatch(REVIEWS_VALUE);
    expect(resumed).toMatch(LIVE_VALUE);
    expect(resumed).toMatch(REVIEWS_VALUE);

    const response = await page.goto(url);
    expect(response?.headers()["x-rango-shell"]).toBe("HIT");
    await waitForHydration(page);
    await expect(testId(page, "ppr-jsx-related")).toHaveText("Related to p1");
    // The stamp beside the hole comes from the pin, not the HIT's fresh run.
    await expect(testId(page, "ppr-jsx-live-run")).toHaveText(captured!);
    const live = testId(page, "ppr-jsx-live");
    await expect(live).toHaveCount(1);
    await expect(live).toHaveText(LIVE_VALUE);
    await expect(testId(page, "ppr-jsx-reviews")).toHaveText(REVIEWS_VALUE);
  });
}

test.describe("ppr bake-lane loader with JSX (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  defineBakeLaneJsxTests(f);
});

test.describe("ppr bake-lane loader with JSX (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  defineBakeLaneJsxTests(f);
});
