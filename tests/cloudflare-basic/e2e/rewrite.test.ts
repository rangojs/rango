import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { expectConsole } from "@shared/e2e";
import { useFixture, type Fixture } from "./fixture";
import {
  expectNoPageError,
  expectNoReload,
  goBack,
  testId,
  waitForHydration,
} from "./helper";

// throw rewrite() from middleware renders another route at the same URL
// (src/pages/rewrite.tsx). The rw-lock cookie turns the lock on per test, so
// the routes behave normally for every other suite.

async function goForward(page: Page) {
  await Promise.all([
    page.waitForURL(/.*/, { waitUntil: "networkidle" }),
    page.goForward(),
  ]);
}

async function lock(
  page: Page,
  f: Fixture,
  mode: "on" | "naive" | "client-urls",
) {
  await page
    .context()
    .addCookies([{ name: "rw-lock", value: mode, url: f.url("/") }]);
}

async function waitForOnError(
  request: APIRequestContext,
  f: Fixture,
  text: string,
): Promise<{ phase: string; message: string }> {
  let found: { phase: string; message: string } | undefined;
  await expect
    .poll(async () => {
      const log = (await (
        await request.get(f.url("/__test/last-error"))
      ).json()) as Array<{ phase: string; message: string }> | null;
      found = log?.find((entry) => entry.message.includes(text));
      return found !== undefined;
    })
    .toBe(true);
  return found!;
}

function rewriteTests(f: Fixture) {
  test("a locked document renders the lock page at the visitor's URL", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await lock(page, f, "on");
    const response = await page.goto(f.url("/rw/shop?ref=mail"));

    expect(response?.status()).toBe(503);
    const headers = response!.headers();
    expect(headers["x-rango-rewrite"]).toBe("/rw/maintenance");
    expect(headers["retry-after"]).toBe("600");
    // Only the target pass resumed after next(); the shop's own route
    // middleware never ran.
    expect(headers["x-rw-post"]).toBe("/rw/maintenance");
    expect(headers["x-rw-shop-post"]).toBeUndefined();
    // A cookie set before the throw reaches the target's response.
    expect(
      (await page.context().cookies()).find((c) => c.name === "rw-pass-one")
        ?.value,
    ).toBe("kept");

    await waitForHydration(page);
    expect(new URL(page.url()).pathname).toBe("/rw/shop");
    await expect(testId(page, "rw-maintenance")).toBeVisible();
    await expect(testId(page, "rw-shop")).toHaveCount(0);
    await expect(testId(page, "rw-reason")).toHaveText("deploy");
    await expect(testId(page, "rw-pathname")).toHaveText("/rw/maintenance");
    await expect(testId(page, "rw-from")).toHaveText("/rw/shop?ref=mail");
    // Global middleware ran once per pass; the rewrittenFrom-guarded count
    // once per request.
    await expect(testId(page, "rw-runs")).toHaveText("2");
    await expect(testId(page, "rw-count")).toHaveText("1");
    // Hydrated with the address bar's location, no mismatch.
    await expect(testId(page, "rw-client-location")).toHaveText(
      "/rw/shop?ref=mail",
    );
  });

  test("a soft navigation to a locked URL renders the lock page, back and forward keep it", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    // Locked before the page loads: a production viewport prefetch of the
    // link already gets the lock page, cached under the link's own URL.
    await lock(page, f, "on");
    await page.goto(f.url("/rw"));
    await waitForHydration(page);

    {
      await using _reload = await expectNoReload(page);
      await testId(page, "rw-link-product").click();
      await page.waitForURL((url) => url.pathname === "/rw/products/hat");
      await expect(testId(page, "rw-maintenance")).toBeVisible();
      await expect(testId(page, "rw-from")).toHaveText("/rw/products/hat");
      await expect(testId(page, "rw-client-location")).toHaveText(
        "/rw/products/hat",
      );
      await expect(testId(page, "rw-product")).toHaveCount(0);
    }

    await goBack(page);
    await page.waitForURL((url) => url.pathname === "/rw");
    await expect(testId(page, "rw-index")).toBeVisible();

    await goForward(page);
    await page.waitForURL((url) => url.pathname === "/rw/products/hat");
    await expect(testId(page, "rw-maintenance")).toBeVisible();

    // The lock lifts: a reload renders the product.
    await page.context().clearCookies({ name: "rw-lock" });
    await page.reload();
    await expect(testId(page, "rw-product")).toHaveText("Product hat");
  });

  test("a clientUrls() navigation to a locked page applies the rewritten route", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await lock(page, f, "client-urls");
    await page.goto(f.url("/__client-urls"));
    await waitForHydration(page);
    await expect(testId(page, "client-urls-index")).toBeVisible();

    await testId(page, "client-urls-detail-link").click();
    await page.waitForURL(
      (url) => url.pathname === "/__client-urls/deterministic-slug",
    );
    await expect(testId(page, "rw-maintenance")).toBeVisible();
    await expect(testId(page, "rw-client-location")).toHaveText(
      "/__client-urls/deterministic-slug",
    );
    await expect(testId(page, "client-urls-detail")).toHaveCount(0);
  });

  test("a rewrite to a pattern-guarded route runs the guard", async ({
    request,
  }) => {
    const denied = await request.get(f.url("/rw/to-guarded"));
    expect(denied.status()).toBe(401);
    expect(await denied.text()).toBe("Unauthorized");

    const allowed = await request.get(f.url("/rw/to-guarded"), {
      headers: { cookie: "rw-auth=1" },
    });
    expect(allowed.status()).toBe(200);
    expect(allowed.headers()["x-rango-rewrite"]).toBe("/rw/guarded/page");
    const html = await allowed.text();
    expect(html).toContain("Guarded page");
    expect(html).not.toContain("never rendered");
  });

  test("an inline path guard decides on the rewritten URL", async ({
    request,
  }) => {
    const denied = await request.get(f.url("/rw/to-inline-admin"));
    expect(denied.status()).toBe(403);

    const allowed = await request.get(f.url("/rw/to-inline-admin"), {
      headers: { cookie: "rw-admin=1" },
    });
    expect(allowed.status()).toBe(200);
    expect(await allowed.text()).toContain("Inline admin");
  });

  test("a JS action under the lock gets the middleware's 503 Response", async ({
    page,
  }) => {
    // The action bridge cannot read the 503's text body as a Flight stream.
    expectConsole(page, {
      allow: [/Unhandled error caught: Error: Connection closed/],
    });
    await page.goto(f.url("/rw/shop"));
    await waitForHydration(page);
    await lock(page, f, "on");

    const post = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().includes("/rw/shop"),
    );
    await testId(page, "rw-save").click();
    const response = await post;
    expect(response.status()).toBe(503);
    expect(response.headers()["retry-after"]).toBe("600");
    expect(await response.text()).toBe("Maintenance");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      /Internal Server Error|Connection Error/,
    );
  });

  test("middleware that rewrites a JS action fails with the rule", async ({
    page,
    request,
  }) => {
    expectConsole(page, {
      allow: [/Unhandled error caught: Error: Connection closed/],
    });
    await page.goto(f.url("/rw/shop"));
    await waitForHydration(page);
    await lock(page, f, "naive");

    const post = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().includes("/rw/shop"),
    );
    await testId(page, "rw-save").click();
    expect((await post).status()).toBe(500);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      /Internal Server Error|Connection Error/,
    );
    const reported = await waitForOnError(
      request,
      f,
      "middleware threw it while handling a non-GET request",
    );
    expect(reported.phase).toBe("routing");
  });

  test("a rewrite loop answers 508 and reports the trail", async ({
    request,
  }) => {
    const response = await request.get(f.url("/rw/loop-a"));
    expect(response.status()).toBe(508);
    expect(response.headers()["x-rango-rewrite"]).toBeUndefined();
    const reported = await waitForOnError(
      request,
      f,
      "Infinite rewrite loop: /rw/loop-a -> /rw/loop-b",
    );
    expect(reported.phase).toBe("routing");
  });

  // The app's root `/*` catch-all matches every path, so there is no 404 to
  // reach; the test-app suite pins the no-match 404. Here a rewrite target no
  // /rw route owns resolves exactly like a direct request to it.
  test("a rewrite to a path only the root catch-all matches renders the catch-all page", async ({
    request,
  }) => {
    const response = await request.get(f.url("/rw/gone"));
    expect(response.status()).toBe(200);
    expect(response.headers()["x-rango-rewrite"]).toBe("/rw/nowhere");
    expect(await response.text()).toContain('data-testid="catch-all-page"');
  });

  test("a route handler cannot rewrite: the throw is a 500", async ({
    request,
  }) => {
    const response = await request.get(f.url("/rw/handler-throws"));
    expect(response.status()).toBe(500);
    expect(response.headers()["x-rango-rewrite"]).toBeUndefined();
    await waitForOnError(request, f, 'rewrite("/rw/shop")');
  });
}

function noJsRewriteTests(f: Fixture) {
  test("a no-JS form post under the lock gets the middleware's 503 Response", async ({
    page,
  }) => {
    await page.goto(f.url("/rw/shop"));
    await expect(testId(page, "rw-shop")).toBeVisible();
    await lock(page, f, "on");

    const post = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().includes("/rw/shop"),
    );
    await testId(page, "rw-save").click();
    const response = await post;
    expect(response.status()).toBe(503);
    await expect(page.locator("body")).toHaveText("Maintenance");
  });

  test("middleware that rewrites a no-JS form post fails with the rule", async ({
    page,
    request,
  }) => {
    await page.goto(f.url("/rw/shop"));
    await expect(testId(page, "rw-shop")).toBeVisible();
    await lock(page, f, "naive");

    const post = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().includes("/rw/shop"),
    );
    await testId(page, "rw-save").click();
    expect((await post).status()).toBe(500);
    await waitForOnError(
      request,
      f,
      "middleware threw it while handling a non-GET request",
    );
  });
}

test.describe("throw rewrite() from middleware", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  rewriteTests(f);
  test.describe("without JavaScript", () => {
    test.use({ javaScriptEnabled: false });
    noJsRewriteTests(f);
  });
});

test.describe("throw rewrite() from middleware (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  rewriteTests(f);
  test.describe("without JavaScript", () => {
    test.use({ javaScriptEnabled: false });
    noJsRewriteTests(f);
  });
});
