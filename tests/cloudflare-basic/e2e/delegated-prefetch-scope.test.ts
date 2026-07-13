import { expect, test } from "@playwright/test";
import { isPrefetchRequest } from "@rangojs/router/testing/e2e";
import { useFixture, type Fixture } from "./fixture";
import { waitForHydration } from "./helper";

function runDelegatedPrefetchScopeSpec(f: Fixture): void {
  test("plain-anchor prefetch stays within the router URL namespace", async ({
    page,
  }) => {
    const prefetches: string[] = [];
    page.on("request", (request) => {
      if (isPrefetchRequest(request)) prefetches.push(request.url());
    });

    await page.goto(f.url("/__prefetch-scope"));
    await waitForHydration(page);

    await expect
      .poll(() =>
        prefetches.some(
          (url) => new URL(url).pathname === "/__prefetch-scope/target",
        ),
      )
      .toBe(true);
    await page.waitForTimeout(500);
    expect(
      prefetches.some(
        (url) => new URL(url).pathname === "/__prefetch-scope/files/report.pdf",
      ),
    ).toBe(false);
    expect(prefetches.some((url) => new URL(url).pathname === "/about")).toBe(
      false,
    );

    const navigationRequest = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname ===
          "/__prefetch-scope/files/report.pdf" &&
        new URL(request.url()).searchParams.get("_rsc_partial") === "true" &&
        !isPrefetchRequest(request),
    );
    await page.getByTestId("prefetch-resource").click();
    const request = await navigationRequest;
    expect(new URL(request.url()).searchParams.get("_rsc_partial")).toBe(
      "true",
    );
  });

  test("initial payload carries the delegated-prefetch scope metadata", async ({
    page,
  }) => {
    const response = await page.request.get(
      f.url("/__prefetch-scope?__rsc=1"),
      { headers: { "X-Rango-State": "test:1" } },
    );

    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toMatch(/"defaultPrefetch"\s*:\s*"viewport"/);
    expect(body).toMatch(/"basename"\s*:\s*"\/__prefetch-scope"/);
  });
}

test.describe("delegated-prefetch-scope", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runDelegatedPrefetchScopeSpec(f);
});

test.describe("delegated-prefetch-scope (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runDelegatedPrefetchScopeSpec(f);
});
