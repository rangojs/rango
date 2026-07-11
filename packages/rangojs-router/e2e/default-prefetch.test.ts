import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, isPrefetchRequest } from "./helper";

function runDefaultPrefetchSpec(
  f: ReturnType<typeof useFixture>,
  expected: "none" | "viewport",
): void {
  test("a bare Link follows the environment default", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (req) => {
      if (
        isPrefetchRequest(req) &&
        req.url().includes("_rsc_partial") &&
        new URL(req.url()).pathname.endsWith("/blog")
      ) {
        requests.push(req.url());
      }
    });

    await page.goto(f.url("/hash-navigation"));
    await waitForHydration(page);

    if (expected === "viewport") {
      await expect.poll(() => requests.length).toBeGreaterThan(0);
      expect(new URL(requests[0]!).searchParams.get("_rsc_partial")).toBe(
        "true",
      );
    } else {
      await page.waitForTimeout(2_000);
      expect(requests).toHaveLength(0);
    }
  });

  test("initial RSC payload carries the built-in default strategy", async ({
    page,
  }) => {
    const res = await page.request.get(f.url("/?__rsc=1"), {
      headers: { "X-Rango-State": "test:1" },
    });
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toMatch(new RegExp(`"defaultPrefetch"\\s*:\\s*"${expected}"`));
  });

  test("an offscreen bare Link follows the environment default", async ({
    page,
  }) => {
    const targetRequests: string[] = [];
    page.on("request", (req) => {
      if (
        isPrefetchRequest(req) &&
        new URL(req.url()).pathname.endsWith("/blog/post-5")
      ) {
        targetRequests.push(req.url());
      }
    });

    await page.goto(f.url("/hash-navigation"));
    await waitForHydration(page);

    const link = page.getByTestId("link-default-prefetch-offscreen");
    const top = await link.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    expect(top).toBeGreaterThan(920);
    await page.waitForTimeout(500);
    expect(targetRequests).toHaveLength(0);

    await link.scrollIntoViewIfNeeded();
    if (expected === "viewport") {
      await expect.poll(() => targetRequests.length).toBeGreaterThan(0);
      expect(new URL(targetRequests[0]!).searchParams.get("_rsc_partial")).toBe(
        "true",
      );
    } else {
      await page.waitForTimeout(500);
      expect(targetRequests).toHaveLength(0);
    }
  });
}

test.describe("default-prefetch", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  runDefaultPrefetchSpec(f, "none");
});

test.describe("default-prefetch (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  runDefaultPrefetchSpec(f, "viewport");
});
