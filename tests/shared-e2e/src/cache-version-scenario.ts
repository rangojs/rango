import { expect, type Browser, type Page } from "@playwright/test";
import { readBuiltVersions, type DeployFixture } from "./deploy-fixture.js";

/**
 * The deploy scenario both cache-version suites run (the node fixture with
 * VercelCacheStore, the Cloudflare fixture with CFCacheStore).
 *
 * The fixture is a host router with two apps, "a" and "b", picked by a
 * host-override cookie. Each app has:
 *
 * - `/cached`, a route inside `cache()` that renders `Date.now()` in
 *   `[data-testid="stamp"]`: the same number on a later request means the
 *   store served the entry an earlier request wrote (cached data, keyed by the
 *   data version);
 * - `/shell`, a `ppr` route that renders `Date.now()` into its prelude:
 *   `x-rango-shell: HIT` with the same number means the stored shell was
 *   served (stored HTML, keyed by the document version);
 * - `/`, `/one`, `/two`, `/three`, plain routes linked from a client nav, for
 *   client-side navigations of an open tab.
 *
 * What it pins, as a consumer sees it (data / stored HTML / open tab):
 *
 * | Deploy                         | App A                      | App B                      |
 * | ------------------------------ | -------------------------- | -------------------------- |
 * | restart, same build            | kept / kept                | kept / kept                |
 * | rebuild, nothing changed       | kept / kept / stays        | kept / kept / stays        |
 * | app A's server code changed    | cleared / cleared / reload | kept / kept / stays        |
 * | a shared client module changed | kept / cleared / reload    | kept / cleared / reload    |
 */
export interface CacheVersionScenarioOptions {
  fixture: DeployFixture;
  browser: Browser;
  /** Host-override cookie name of the fixture's host router. */
  hostCookie: string;
  /** Router source files as `vite build` prints them. */
  routerSource: { a: string; b: string };
  /** A server-only change to app A. */
  serverEdit: { file: string; change: (source: string) => string };
  /** A change to a client module both apps render. */
  clientEdit: { file: string; change: (source: string) => string };
}

type App = "a" | "b";

/** A marker a full page load cannot survive. */
async function markTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __cacheVersionTab?: boolean }).__cacheVersionTab =
      true;
  });
}

function tabSurvived(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      (window as unknown as { __cacheVersionTab?: boolean })
        .__cacheVersionTab === true,
  );
}

export async function runCacheVersionScenario(
  options: CacheVersionScenarioOptions,
): Promise<void> {
  const { fixture, browser, hostCookie, routerSource } = options;
  const host = (app: App) => `${app}.localhost`;

  async function stamp(app: App): Promise<string> {
    const res = await fetch(fixture.url("/cached"), {
      headers: { accept: "text/html", cookie: `${hostCookie}=${host(app)}` },
    });
    const html = await res.text();
    const match = html.match(/data-testid="stamp"[^>]*>(?:<!-- -->)?(\d+)/);
    if (res.status !== 200 || !match) {
      throw new Error(
        `no stamp in /cached of app ${app} (status ${res.status}):\n${html.slice(0, 2000)}`,
      );
    }
    return match[1]!;
  }

  /** A document GET of the ppr route: its shell status and prelude stamp. */
  async function shell(app: App): Promise<{ status: string; stamp: string }> {
    const res = await fetch(fixture.url("/shell"), {
      headers: { accept: "text/html", cookie: `${hostCookie}=${host(app)}` },
    });
    const html = await res.text();
    const match = html.match(
      /data-testid="shell-stamp"[^>]*>(?:<!-- -->)?(\d+)/,
    );
    if (res.status !== 200 || !match) {
      throw new Error(
        `no stamp in /shell of app ${app} (status ${res.status}):\n${html.slice(0, 2000)}`,
      );
    }
    return { status: res.headers.get("x-rango-shell") ?? "", stamp: match[1]! };
  }

  /**
   * Expect a MISS (nothing stored under this document version), then the
   * stamp of the shell that request captured. The capture is stored after the
   * response, so the HIT is polled for.
   */
  async function captureShell(app: App, why: string): Promise<string> {
    expect((await shell(app)).status, why).toBe("MISS");
    let hit: { status: string; stamp: string } | undefined;
    await expect
      .poll(
        async () => {
          hit = await shell(app);
          return hit.status;
        },
        { timeout: 20_000, message: `shell of app ${app} was never stored` },
      )
      .toBe("HIT");
    return hit!.stamp;
  }

  async function openTab(app: App): Promise<Page> {
    const context = await browser.newContext();
    await context.addCookies([
      { name: hostCookie, value: host(app), url: fixture.url("/") },
    ]);
    const page = await context.newPage();
    await page.goto(fixture.url("/"));
    await page.waitForFunction(
      () => document.documentElement.hasAttribute("data-hydrated"),
      { timeout: 20_000 },
    );
    await expect(page.getByTestId("app")).toHaveText(app);
    await markTab(page);
    return page;
  }

  /** Click a nav link and wait for the destination page. */
  async function navigate(
    page: Page,
    link: "home" | "one" | "two" | "three",
    text: string | RegExp,
  ): Promise<void> {
    await page.getByTestId(`link-${link}`).click();
    await expect(page.getByTestId("page")).toHaveText(text);
  }

  const versions = (output: string) => ({
    a: readBuiltVersions(output, routerSource.a),
    b: readBuiltVersions(output, routerSource.b),
  });

  // Build 1.
  const built1 = versions(await fixture.build());
  await fixture.start();
  const a1 = await stamp("a");
  const b1 = await stamp("b");
  expect(await stamp("a"), "second request on the same server").toBe(a1);
  expect(a1).not.toBe(b1);
  const shellA1 = await captureShell("a", "first request for app A's shell");
  const shellB1 = await captureShell("b", "first request for app B's shell");

  // Restart on the same build: the store is persistent.
  await fixture.stop();
  await fixture.start();
  expect(await stamp("a"), "after a restart on the same build").toBe(a1);
  expect(await shell("a"), "app A's shell after a restart").toEqual({
    status: "HIT",
    stamp: shellA1,
  });

  const tabA = await openTab("a");
  const tabB = await openTab("b");
  await navigate(tabA, "one", "A one");
  await navigate(tabB, "one", "B one");
  expect(await tabSurvived(tabA)).toBe(true);
  expect(await tabSurvived(tabB)).toBe(true);

  // Deploy 2: rebuild of unchanged source.
  const built2 = versions(await fixture.deploy());
  expect(built2, "an unchanged rebuild keeps every version").toEqual(built1);
  expect(await stamp("a"), "app A after an unchanged rebuild").toBe(a1);
  expect(await stamp("b"), "app B after an unchanged rebuild").toBe(b1);
  expect(await shell("a"), "app A's shell after an unchanged rebuild").toEqual({
    status: "HIT",
    stamp: shellA1,
  });
  expect(await shell("b"), "app B's shell after an unchanged rebuild").toEqual({
    status: "HIT",
    stamp: shellB1,
  });
  await navigate(tabA, "two", "A two");
  await navigate(tabB, "two", "B two");
  expect(
    await tabSurvived(tabA),
    "an unchanged rebuild must not reload app A's tab",
  ).toBe(true);
  expect(
    await tabSurvived(tabB),
    "an unchanged rebuild must not reload app B's tab",
  ).toBe(true);

  // Deploy 3: a server-only change to app A.
  fixture.edit(options.serverEdit.file, options.serverEdit.change);
  const built3 = versions(await fixture.deploy());
  expect(built3.b, "app B's versions after a change to app A").toEqual(
    built1.b,
  );
  expect(built3.a.data).not.toBe(built1.a.data);
  expect(built3.a.document).not.toBe(built1.a.document);
  const a3 = await stamp("a");
  expect(a3, "app A's entry after its server code changed").not.toBe(a1);
  expect(await stamp("a")).toBe(a3);
  expect(await stamp("b"), "app B's entry after a change to app A").toBe(b1);
  const shellA3 = await captureShell(
    "a",
    "app A's shell after its server code changed",
  );
  expect(shellA3).not.toBe(shellA1);
  expect(await shell("b"), "app B's shell after a change to app A").toEqual({
    status: "HIT",
    stamp: shellB1,
  });
  await navigate(tabA, "three", "A three");
  await navigate(tabB, "three", "B three");
  expect(
    await tabSurvived(tabA),
    "app A's tab must reload after app A's server code changed",
  ).toBe(false);
  expect(
    await tabSurvived(tabB),
    "app B's tab must not reload after a change to app A",
  ).toBe(true);
  await markTab(tabA);

  // Deploy 4: a client-only change both apps render.
  fixture.edit(options.clientEdit.file, options.clientEdit.change);
  const built4 = versions(await fixture.deploy());
  expect(built4.a.data, "a client change keeps app A's data version").toBe(
    built3.a.data,
  );
  expect(built4.b.data, "a client change keeps app B's data version").toBe(
    built3.b.data,
  );
  expect(built4.a.document).not.toBe(built3.a.document);
  expect(built4.b.document).not.toBe(built3.b.document);
  expect(await stamp("a"), "app A's entry after a client change").toBe(a3);
  expect(await stamp("b"), "app B's entry after a client change").toBe(b1);
  // Stored HTML names the client assets, so both apps' shells are replaced.
  expect((await shell("a")).status, "app A's shell after a client change").toBe(
    "MISS",
  );
  expect((await shell("b")).status, "app B's shell after a client change").toBe(
    "MISS",
  );
  await navigate(tabA, "home", /App A/);
  await navigate(tabB, "home", /App B/);
  expect(
    await tabSurvived(tabA),
    "a client change must reload app A's tab",
  ).toBe(false);
  expect(
    await tabSurvived(tabB),
    "a client change must reload app B's tab",
  ).toBe(false);

  await tabA.context().close();
  await tabB.context().close();
}
