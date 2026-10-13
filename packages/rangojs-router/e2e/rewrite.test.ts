import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import {
  expectConsole,
  markServerNode,
  serverNodeKept,
  warmShellRequestToHit,
} from "@shared/e2e";
import { useFixture } from "./fixture";
import {
  expectNoPageError,
  expectNoReload,
  goBack,
  goForward,
  testId,
  waitForHydration,
} from "./helper";

// throw rewrite() from middleware renders another route at the same URL
// (test-app/src/urls/rewrite.tsx). The rw-lock cookie turns the lock on per
// test, so the routes behave normally for every other suite.

type Fixture = ReturnType<typeof useFixture>;

async function lock(
  page: Page,
  f: Fixture,
  mode: "on" | "naive" | "client-urls",
) {
  await page
    .context()
    .addCookies([{ name: "rw-lock", value: mode, url: f.url("/") }]);
}

/**
 * Hydration errors a recovered mismatch reports to the console (dev's
 * "Hydration failed", production's minified #418) as well as page errors.
 */
function watchHydrationErrors(page: Page): string[] {
  const seen: string[] = [];
  const hydration = /hydrat|#418|#423|#425/i;
  page.on("console", (message) => {
    if (message.type() === "error" && hydration.test(message.text())) {
      seen.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    if (hydration.test(error.message)) seen.push(error.message);
  });
  return seen;
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

/** A cookie keying the item saves to this test (urls/rewrite-saves.ts). */
async function useSaveKey(page: Page, f: Fixture): Promise<void> {
  await page
    .context()
    .addCookies([
      { name: "rw-key", value: crypto.randomUUID(), url: f.url("/") },
    ]);
}

/** Mark the layout's and the page's DOM nodes before an action. */
async function markIdentity(page: Page): Promise<void> {
  for (const id of ["rw-layout", "rw-item"]) {
    await testId(page, id).evaluate((el) => {
      (el as HTMLElement & { __rwMark?: boolean }).__rwMark = true;
    });
  }
}

/** The marked nodes are still mounted: neither the layout nor the page remounted. */
async function expectIdentityKept(page: Page): Promise<void> {
  for (const id of ["rw-layout", "rw-item"]) {
    expect(
      await testId(page, id).evaluate(
        (el) => (el as HTMLElement & { __rwMark?: boolean }).__rwMark === true,
      ),
    ).toBe(true);
  }
}

/** The node rendering usePathname(): a hydration mismatch replaces it. */
const LOCATION_NODE = '[data-testid="rw-client-location"]';

function rewriteTests(f: Fixture) {
  test("a rewritten ppr page renders live at the visitor's URL, even with the target's shell warm", async ({
    page,
    request,
  }) => {
    using _ = expectNoPageError(page);
    const hydrationErrors = watchHydrationErrors(page);
    const id = `a1-${crypto.randomUUID().slice(0, 8)}`;
    await warmShellRequestToHit(request, f.url(`/rw/ppr/${id}`));
    await markServerNode(page, LOCATION_NODE);

    for (let visit = 0; visit < 2; visit++) {
      const response = await page.goto(f.url(`/rw/promo/${id}`));
      expect(response?.headers()["x-rango-rewrite"]).toBe(`/rw/ppr/${id}`);
      // No shell read, no capture.
      expect(response?.headers()["x-rango-shell"]).toBeUndefined();
      await waitForHydration(page);
      await expect(testId(page, "rw-client-location")).toHaveText(
        `/rw/promo/${id}`,
      );
      await expect(testId(page, "rw-ppr-public")).toHaveText(`/rw/promo/${id}`);
      await expect(testId(page, "rw-ppr-from")).toHaveText(`/rw/promo/${id}`);
      expect(await serverNodeKept(page, LOCATION_NODE)).toBe(true);
    }
    expect(hydrationErrors).toEqual([]);
  });

  test('a .shell("visitor") rewrite serves its own shell, hydrating at the visitor\'s URL', async ({
    page,
    request,
  }) => {
    using _ = expectNoPageError(page);
    const hydrationErrors = watchHydrationErrors(page);
    const id = `rv-${crypto.randomUUID().slice(0, 8)}`;
    await warmShellRequestToHit(request, f.url(`/rw/summer/${id}`));
    await markServerNode(page, LOCATION_NODE);

    const response = await page.goto(f.url(`/rw/summer/${id}`));
    expect(response?.headers()["x-rango-shell"]).toBe("HIT");
    await waitForHydration(page);
    await expect(testId(page, "rw-client-location")).toHaveText(
      `/rw/summer/${id}`,
    );
    await expect(testId(page, "rw-ppr-public")).toHaveText(`/rw/summer/${id}`);
    await expect(testId(page, "rw-ppr-from")).toHaveText(`/rw/summer/${id}`);
    expect(await serverNodeKept(page, LOCATION_NODE)).toBe(true);
    expect(hydrationErrors).toEqual([]);

    // The target's own URL has its own shell, captured by a direct visit.
    const direct = await request.get(f.url(`/rw/ppr/${id}`), {
      headers: { Accept: "text/html" },
    });
    expect(direct.headers()["x-rango-shell"]).toBe("MISS");
  });

  test('a .shell("target") rewrite shares the target\'s shell with direct visits', async ({
    request,
  }) => {
    const id = `rt-${crypto.randomUUID().slice(0, 8)}`;
    const html = { headers: { Accept: "text/html" } };
    const miss = await request.get(f.url(`/rw/shared/${id}`), html);
    expect(miss.headers()["x-rango-shell"]).toBe("MISS");
    // The rewritten request captured the target's shell: a direct visit HITs.
    await warmShellRequestToHit(request, f.url(`/rw/ppr/${id}`));
    const rewritten = await request.get(f.url(`/rw/shared/${id}`), html);
    expect(rewritten.headers()["x-rango-shell"]).toBe("HIT");
    // The documented caveat: the shared shell shows the target's location.
    expect(await rewritten.text()).toContain(
      `data-testid="rw-client-location">/rw/ppr/${id}<`,
    );
  });

  test("a locked document renders the lock page at the visitor's URL", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    const hydrationErrors = watchHydrationErrors(page);
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
    expect(hydrationErrors).toEqual([]);
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
    await page.goto(f.url("/client-urls-e2e"));
    await waitForHydration(page);

    await testId(page, "client-urls-item-link").click();
    await page.waitForURL(
      (url) => url.pathname === "/client-urls-e2e/items/soft-nav",
    );
    await expect(testId(page, "rw-maintenance")).toBeVisible();
    await expect(testId(page, "rw-client-location")).toHaveText(
      "/client-urls-e2e/items/soft-nav",
    );
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

  test("a JS action from a page route middleware rewrote re-renders that page and runs once", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await useSaveKey(page, f);
    await page.goto(f.url("/rw/public/7"));
    await waitForHydration(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Item 7");
    await expect(testId(page, "rw-item-saves")).toHaveText("0");
    await using _reload = await expectNoReload(page);
    await markIdentity(page);

    const post = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" && r.url().includes("/rw/public/7"),
    );
    await testId(page, "rw-item-save").click();
    const response = await post;
    expect(response.status()).toBe(200);
    expect(response.headers()["x-rango-rewrite"]).toBe("/rw/items/7");

    await expect(testId(page, "rw-item-saves")).toHaveText("1");
    // The target's route middleware and its global middleware ran on the
    // re-render (one global run per pass).
    await expect(testId(page, "rw-item-guard")).toHaveText("target");
    await expect(testId(page, "rw-runs")).toHaveText("2");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Item 7");
    await expect(testId(page, "rw-client-location")).toHaveText("/rw/public/7");
    expect(new URL(page.url()).pathname).toBe("/rw/public/7");
    await expectIdentityKept(page);
  });

  test("a navigation from a page route middleware rewrote holds its route and a param-scoped loader", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await useSaveKey(page, f);
    // /rw/catalog/:slug rewrites to /rw/items/:id: the visitor's URL matches
    // a route whose params are not the target's (#1144).
    await page.goto(f.url("/rw/catalog/7?sort=a"));
    await waitForHydration(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Item 7");
    await expect(testId(page, "rw-item-loads")).toHaveText("1");
    await expect(testId(page, "rw-item-renders")).toHaveText("1");
    await using _reload = await expectNoReload(page);
    await markIdentity(page);

    // A sort change re-renders the route (its search changed) and holds the
    // loader, whose revalidate() compares the item id.
    await testId(page, "rw-item-sort").click();
    await expect(page).toHaveURL(/\/rw\/catalog\/7\?sort=b$/);
    await expect(testId(page, "rw-item-renders")).toHaveText("2");
    await expect(testId(page, "rw-item-loads")).toHaveText("1");
    await expect(testId(page, "rw-client-location")).toHaveText(
      "/rw/catalog/7?sort=b",
    );

    // Back to ?sort=a, then the same navigation from that entry again.
    await goBack(page);
    await expect(page).toHaveURL(/\/rw\/catalog\/7\?sort=a$/);
    await expect(testId(page, "rw-client-location")).toHaveText(
      "/rw/catalog/7?sort=a",
    );
    await testId(page, "rw-item-sort").click();
    await expect(page).toHaveURL(/\/rw\/catalog\/7\?sort=b$/);
    await expect(testId(page, "rw-client-location")).toHaveText(
      "/rw/catalog/7?sort=b",
    );
    await expect(testId(page, "rw-item-loads")).toHaveText("1");

    // A server action from the page re-renders against the item route: the
    // loader's revalidate() holds it there too.
    await testId(page, "rw-item-save").click();
    await expect(testId(page, "rw-item-saves")).toHaveText("1");
    await expect(testId(page, "rw-item-loads")).toHaveText("1");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Item 7");
    await expectIdentityKept(page);
  });

  test("a loader fetch under the lock rejects with the rule as a loaderError", async ({
    request,
  }) => {
    const response = await request.get(f.url("/rw/shop?_rsc_loader=rw-probe"), {
      headers: { cookie: "rw-lock=on" },
    });
    expect(response.status()).toBe(500);
    expect(response.headers()["content-type"]).toBe(
      "text/x-component;charset=utf-8",
    );
    const body = await response.text();
    expect(body).toContain("loaderError");
    expect(body).toContain("middleware threw it during a loader fetch");
    const reported = await waitForOnError(
      request,
      f,
      "middleware threw it during a loader fetch",
    );
    expect(reported.phase).toBe("routing");
  });

  test("a rewrite after next() ran the route is an error", async ({
    request,
  }) => {
    const response = await request.get(f.url("/rw/after"));
    expect(response.status()).toBe(500);
    expect(response.headers()["x-rango-rewrite"]).toBeUndefined();
    expect(await response.text()).not.toContain('data-testid="rw-shop"');
  });

  test("a rewrite after a next() that failed after rendering is an error", async ({
    request,
  }) => {
    const response = await request.get(f.url("/rw/boom"));
    expect(response.status()).toBe(500);
    expect(response.headers()["x-rango-rewrite"]).toBeUndefined();
    expect(await response.text()).not.toContain('data-testid="rw-shop"');
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

  test("a rewrite to a path no route matches renders the 404 page", async ({
    request,
  }) => {
    const response = await request.get(f.url("/rw/gone"));
    expect(response.status()).toBe(404);
    expect(response.headers()["x-rango-rewrite"]).toBe("/rw/nowhere");
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

  test("a no-JS form post from a page route middleware rewrote re-renders that page and runs once", async ({
    page,
  }) => {
    await useSaveKey(page, f);
    await page.goto(f.url("/rw/public/8"));
    await expect(testId(page, "rw-item-saves")).toHaveText("0");

    const post = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" && r.url().includes("/rw/public/8"),
    );
    await testId(page, "rw-item-save").click();
    const response = await post;
    expect(response.status()).toBe(200);
    expect(response.headers()["x-rango-rewrite"]).toBe("/rw/items/8");

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Item 8");
    await expect(testId(page, "rw-item-saves")).toHaveText("1");
    await expect(testId(page, "rw-item-guard")).toHaveText("target");
    await expect(testId(page, "rw-runs")).toHaveText("2");
    expect(new URL(page.url()).pathname).toBe("/rw/public/8");
  });

  test("a no-JS form post whose action throws on a page route middleware rewrote renders the target's error boundary inside its route middleware", async ({
    page,
  }) => {
    await page.goto(f.url("/rw/public/10"));
    await expect(testId(page, "rw-item-fail")).toBeVisible();

    const post = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" && r.url().includes("/rw/public/10"),
    );
    await testId(page, "rw-item-fail").click();
    const response = await post;
    expect(response.status()).toBe(500);
    expect(response.headers()["x-rango-rewrite"]).toBe("/rw/items/10");

    await expect(testId(page, "rw-item-boundary-guard")).toHaveText("target");
    await expect(testId(page, "rw-public-boundary")).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/rw/public/10");
  });

  test("a no-JS form post whose action throws renders its route's error boundary inside its route middleware", async ({
    page,
  }) => {
    await page.goto(f.url("/rw/items/11"));
    await expect(testId(page, "rw-item-fail")).toBeVisible();

    const post = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" && r.url().includes("/rw/items/11"),
    );
    await testId(page, "rw-item-fail").click();
    const response = await post;
    expect(response.status()).toBe(500);
    expect(response.headers()["x-rango-rewrite"]).toBeUndefined();
    await expect(testId(page, "rw-item-boundary-guard")).toHaveText("target");
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
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  rewriteTests(f);
  test.describe("without JavaScript", () => {
    test.use({ javaScriptEnabled: false });
    noJsRewriteTests(f);
  });
});

test.describe("throw rewrite() from middleware (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  rewriteTests(f);
  test.describe("without JavaScript", () => {
    test.use({ javaScriptEnabled: false });
    noJsRewriteTests(f);
  });
});
