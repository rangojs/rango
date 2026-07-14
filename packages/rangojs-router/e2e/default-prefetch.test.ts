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

  for (const { label, testId, pathname } of [
    {
      label: "bare Link",
      testId: "link-default-prefetch-offscreen",
      pathname: "/blog/post-5",
    },
    {
      label: "plain anchor",
      testId: "anchor-default-prefetch-offscreen",
      pathname: "/blog/post-6",
    },
    {
      label: "static-looking plain-anchor opt-in",
      testId: "anchor-prefetch-resource-route",
      pathname: "/blog/intro-to-node.js",
    },
    {
      label: "malformed-percent plain-anchor opt-in",
      testId: "anchor-prefetch-malformed-route",
      pathname: "/blog/50%off",
    },
  ]) {
    test(`an offscreen ${label} follows the environment default`, async ({
      page,
    }) => {
      const targetRequests: string[] = [];
      const hydrationStates: Promise<boolean>[] = [];
      page.on("request", (req) => {
        if (
          isPrefetchRequest(req) &&
          new URL(req.url()).pathname.endsWith(pathname)
        ) {
          targetRequests.push(req.url());
          hydrationStates.push(
            page.evaluate(() =>
              document.documentElement.hasAttribute("data-hydrated"),
            ),
          );
        }
      });

      await page.goto(f.url("/hash-navigation"));
      await waitForHydration(page);

      const link = page.getByTestId(testId);
      const top = await link.evaluate(
        (element) => element.getBoundingClientRect().top,
      );
      expect(top).toBeGreaterThan(920);
      await page.waitForTimeout(500);
      expect(targetRequests).toHaveLength(0);

      await link.scrollIntoViewIfNeeded();
      if (expected === "viewport") {
        await expect.poll(() => targetRequests.length).toBeGreaterThan(0);
        expect(
          new URL(targetRequests[0]!).searchParams.get("_rsc_partial"),
        ).toBe("true");
        expect(await hydrationStates[0]).toBe(true);
      } else {
        await page.waitForTimeout(500);
        expect(targetRequests).toHaveLength(0);
      }
    });
  }

  test("an opted-out plain anchor never prefetches", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (req) => {
      if (
        isPrefetchRequest(req) &&
        ["/blog/post-7", "/blog/post-8"].includes(new URL(req.url()).pathname)
      ) {
        requests.push(req.url());
      }
    });

    await page.goto(f.url("/hash-navigation"));
    await waitForHydration(page);
    await page.getByTestId("anchor-prefetch-opt-out").scrollIntoViewIfNeeded();
    await page.getByTestId("anchor-prefetch-none").scrollIntoViewIfNeeded();
    await page.waitForTimeout(1_000);

    expect(requests).toHaveLength(0);
  });

  test("a container scope disables Link and plain-anchor prefetch", async ({
    page,
  }) => {
    const requests: string[] = [];
    page.on("request", (req) => {
      if (
        isPrefetchRequest(req) &&
        ["/blog/post-9", "/blog/post-10"].includes(new URL(req.url()).pathname)
      ) {
        requests.push(req.url());
      }
    });

    await page.goto(f.url("/hash-navigation"));
    await waitForHydration(page);
    const componentLink = page.getByTestId("link-prefetch-scope-opt-out");
    const plainLink = page.getByTestId("anchor-prefetch-scope-opt-out");
    await componentLink.scrollIntoViewIfNeeded();
    await componentLink.hover();
    await plainLink.scrollIntoViewIfNeeded();
    await plainLink.hover();
    await page.waitForTimeout(1_000);

    expect(requests).toHaveLength(0);

    const navigationRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname === "/blog/post-10" &&
        url.searchParams.get("_rsc_partial") === "true" &&
        !isPrefetchRequest(request)
      );
    });
    await plainLink.click();
    await navigationRequest;
    await expect(page).toHaveURL(/\/blog\/post-10$/);
  });

  test("removing a container scope re-arms its Link", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (request) => {
      if (
        isPrefetchRequest(request) &&
        new URL(request.url()).pathname === "/blog/post-9"
      ) {
        requests.push(request.url());
      }
    });

    await page.goto(f.url("/hash-navigation"));
    await waitForHydration(page);
    const link = page.getByTestId("link-prefetch-scope-opt-out");
    await link.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    expect(requests).toHaveLength(0);

    await page
      .getByTestId("prefetch-scope-opt-out")
      .evaluate((element) => element.removeAttribute("data-prefetch-scope"));

    await expect.poll(() => requests.length).toBeGreaterThan(0);
  });

  test("a static-resource plain anchor never prefetches", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (req) => {
      if (
        isPrefetchRequest(req) &&
        new URL(req.url()).pathname.endsWith("/files/report.pdf")
      ) {
        requests.push(req.url());
      }
    });

    await page.goto(f.url("/hash-navigation"));
    await waitForHydration(page);
    await page.getByTestId("anchor-prefetch-resource").scrollIntoViewIfNeeded();
    await page.waitForTimeout(1_000);

    expect(requests).toHaveLength(0);
  });

  test("an inline SVG anchor does not prefetch or break hydration", async ({
    page,
  }) => {
    const requests: string[] = [];
    page.on("request", (req) => {
      if (
        isPrefetchRequest(req) &&
        new URL(req.url()).pathname.endsWith("/blog/svg-link")
      ) {
        requests.push(req.url());
      }
    });

    await page.goto(f.url("/hash-navigation"));
    await waitForHydration(page);
    await page.getByTestId("svg-prefetch-link").scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    expect(requests).toHaveLength(0);
  });

  test("an adopted cross-realm anchor keeps delegated SPA interception", async ({
    page,
  }) => {
    await page.goto(f.url("/hash-navigation"));
    await waitForHydration(page);
    const isCurrentRealm = await page.evaluate(() => {
      const iframe = document.createElement("iframe");
      document.body.appendChild(iframe);
      const foreignLink = iframe.contentDocument!.createElement("a");
      const adoptedLink = document.adoptNode(foreignLink);
      iframe.remove();
      adoptedLink.href = "/blog?cross-realm-click=1";
      adoptedLink.dataset.prefetch = "false";
      adoptedLink.dataset.testid = "cross-realm-click";
      adoptedLink.textContent = "Cross-realm blog link";
      document.body.appendChild(adoptedLink);
      return adoptedLink instanceof HTMLAnchorElement;
    });
    expect(isCurrentRealm).toBe(false);

    const navigationRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname === "/blog" &&
        url.searchParams.get("cross-realm-click") === "1" &&
        url.searchParams.has("_rsc_partial") &&
        !isPrefetchRequest(request)
      );
    });
    await page.getByTestId("cross-realm-click").click();
    await navigationRequest;
    await expect(page).toHaveURL(/\/blog\?cross-realm-click=1$/);
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
