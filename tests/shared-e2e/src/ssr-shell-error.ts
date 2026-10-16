import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { expectConsole } from "./console-guard.js";

// dc-t93: an error that reaches React's server-render shell (thrown with no
// <Suspense> above it) made the host answer its raw 500: the Vite overlay in
// dev, a stack with server paths in production. Production now answers a
// recovery document carrying the same Flight payload, and the browser entry
// renders it with createRoot, so the document ends where a client navigation
// to the URL ends. A loader notFound() answers 404, a loader redirect() with
// no state a real 3xx. Dev keeps the overlay for an error (dc-q62); a
// notFound()/redirect() is control flow and is answered as in production.
//
// Fixture (both apps): the /holey-throws/shell-* routes in holey-throws.tsx,
// under the layout marked `holey-layout`, with no errorBoundary() except the
// -bounded routes'. /holey-throws/shell is the start of the client
// navigations each document load is compared with.

export interface SsrShellErrorFixture {
  url: (path: string) => string;
  /** A build: the recovery document. Dev: the host's overlay for an error. */
  production: boolean;
  /** The server's output so far, when the suite owns its server process. */
  serverOutput?: () => string;
}

type Case =
  | "shell-loader"
  | "shell-loader-bounded"
  | "shell-not-found"
  | "shell-redirect"
  | "shell-redirect-state"
  | "shell-ppr"
  | "shell-ssr-throw"
  | "shell-ssr-throw-bounded"
  | "shell-hooks";

const ROOT_BOUNDARY_TEXT =
  "An unexpected error occurred while processing your request.";

const pathOf = (name: Case): string => `/holey-throws/${name}`;

interface OnErrorEntry {
  phase: string;
  handledByBoundary?: boolean;
  pathname?: string;
}

async function clearOnErrorLog(
  page: Page,
  fixture: SsrShellErrorFixture,
): Promise<void> {
  const res = await page.request.get(fixture.url("/__test/clear-error-log"));
  expect(res.ok()).toBe(true);
}

/** The router onError calls the document request made, as [phase, handled]. */
async function onErrorFor(
  page: Page,
  fixture: SsrShellErrorFixture,
  name: Case,
): Promise<Array<[string, boolean | undefined]>> {
  const res = await page.request.get(fixture.url("/__test/last-error"));
  const log = ((await res.json()) as OnErrorEntry[] | null) ?? [];
  // A cache() scope that refuses to store the failed render reports its
  // skipped write in the background (phase "cache", category cache-write,
  // #915): the cache layer's own signal, racing this read, not the failure's.
  return log
    .filter(
      (entry) => entry.pathname === pathOf(name) && entry.phase !== "cache",
    )
    .map((entry) => [entry.phase, entry.handledByBoundary]);
}

/** The raw document, redirects not followed. */
async function rawDocument(
  page: Page,
  fixture: SsrShellErrorFixture,
  name: Case,
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const res = await page.request.get(fixture.url(pathOf(name)), {
    headers: { Accept: "text/html" },
    maxRedirects: 0,
  });
  return {
    status: res.status(),
    body: await res.text(),
    headers: res.headers(),
  };
}

/**
 * The recovery document. In production it carries nothing from the server's
 * files; dev's Flight payload carries its debug stacks, as on any dev page.
 */
function expectRecoveryDocument(body: string, production: boolean): void {
  expect(body).toContain('<html data-rango-ssr-error="">');
  expect(body).toContain("__FLIGHT_DATA");
  // The heading is for a browser without JavaScript only.
  expect(body).toMatch(/<noscript><h1>[^<]+<\/h1><\/noscript>/);
  if (!production) return;
  expect(body).not.toContain("file://");
  expect(body).not.toContain("/dist/");
}

/** Dev's answer for an error: the host's overlay page, as before. */
function expectHostOverlay(body: string, message: string): void {
  expect(body).not.toContain("data-rango-ssr-error");
  expect(body).toContain("/@vite/client");
  expect(body).toContain(message);
}

async function expectRendered(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
  // React's client render replaced the recovery document's <html>.
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-rango-ssr-error",
    "",
  );
}

const screens: Record<
  Exclude<Case, "shell-redirect" | "shell-redirect-state" | "shell-hooks">,
  (page: Page) => Promise<void>
> = {
  // No boundary: the router's root error boundary replaces the layouts.
  "shell-loader": async (page) => {
    await expect(page.getByText(ROOT_BOUNDARY_TEXT)).toBeVisible();
    await expect(page.getByTestId("holey-layout")).toHaveCount(0);
  },
  "shell-loader-bounded": async (page) => {
    await expect(page.getByTestId("holey-route-boundary")).toHaveText(
      /^route-boundary: /,
    );
    await expect(page.getByTestId("holey-layout")).toBeVisible();
  },
  "shell-not-found": async (page) => {
    await expect(
      page
        .getByTestId("holey-layout")
        .getByRole("heading", { name: "Not Found" }),
    ).toBeVisible();
  },
  "shell-ppr": async (page) => {
    await expect(page.getByText(ROOT_BOUNDARY_TEXT)).toBeVisible();
    await expect(page.getByTestId("holey-layout")).toHaveCount(0);
  },
  // The browser alone renders it: the page itself.
  "shell-ssr-throw": async (page) => {
    await expect(page.getByTestId("holey-shell-client-rendered")).toBeVisible();
    await expect(page.getByTestId("holey-layout")).toBeVisible();
  },
  "shell-ssr-throw-bounded": async (page) => {
    await expect(page.getByTestId("holey-shell-client-rendered")).toBeVisible();
    await expect(page.getByTestId("holey-route-boundary")).toHaveCount(0);
  },
};

async function expectTarget(page: Page, state: string): Promise<void> {
  await expect(page).toHaveURL(/\/holey-throws\/shell-target$/);
  await expect(page.getByTestId("holey-shell-target-state")).toHaveText(state);
  await expect(page.getByTestId("holey-layout")).toBeVisible();
}

async function navigateFromIndex(
  page: Page,
  fixture: SsrShellErrorFixture,
  name: Case,
): Promise<void> {
  await page.goto(fixture.url("/holey-throws/shell"));
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
  await page.getByTestId(`holey-shell-link-${name}`).click();
}

/** Count the server lines that start a printed `Error: <message>`. */
function printedCount(output: string, line: RegExp): number {
  return output.split("\n").filter((l) => line.test(l)).length;
}

/**
 * The line the server prints for HoleyShellLoader's failure: the original
 * error, with the loader and the pathname, in production too.
 */
function loaderPrint(name: Case): RegExp {
  return new RegExp(
    `^\\[RSC\\] Loader error \\(HoleyShellLoader\\) /holey-throws/${name}: Error: holey-shell-loader-error$`,
  );
}

async function expectPrintedOnce(
  fixture: SsrShellErrorFixture,
  before: number,
  line: RegExp,
): Promise<void> {
  const output = fixture.serverOutput;
  if (!output) return;
  await expect
    .poll(() => printedCount(output().slice(before), line), { timeout: 10_000 })
    .toBe(1);
  // Nothing prints it a second time (the SSR render, the handler, a cache),
  // and nothing prints the client's masked rebuild.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const printed = output().slice(before);
  expect(printedCount(printed, line)).toBe(1);
  expect(printed).not.toMatch(/^(\[RSC\].*: )?Error: An error occurred$/m);
  expect(printed).not.toMatch(/^\[DocumentCache\]/m);
}

/** Dev: printed where it originated; the handler's `[RSC] Error` print stays out. */
async function expectNoHandlerPrint(
  fixture: SsrShellErrorFixture,
  before: number,
): Promise<void> {
  const output = fixture.serverOutput;
  if (!output) return;
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(output().slice(before)).not.toMatch(/^\[RSC\] Error[ :]/m);
}

export function defineSsrShellErrorTests(
  fixture: () => SsrShellErrorFixture,
): void {
  // The onError log is one per server: one test at a time reads it.
  test.describe.configure({ mode: "serial" });

  const errorCases: Array<{
    name: Exclude<
      Case,
      | "shell-redirect"
      | "shell-redirect-state"
      | "shell-hooks"
      | "shell-not-found"
    >;
    message: string;
    onError: Array<[string, boolean]>;
    printed: RegExp;
    /** Browser console lines the client render provokes. */
    console: RegExp[];
  }> = [
    {
      name: "shell-loader",
      message: "holey-shell-loader-error",
      onError: [["loader", false]],
      printed: loaderPrint("shell-loader"),
      console: [/\[RootErrorBoundary\]/],
    },
    {
      name: "shell-loader-bounded",
      message: "holey-shell-loader-error",
      onError: [["loader", true]],
      printed: loaderPrint("shell-loader-bounded"),
      console: [],
    },
    {
      name: "shell-ppr",
      message: "holey-shell-loader-error",
      onError: [["loader", false]],
      printed: loaderPrint("shell-ppr"),
      console: [/\[RootErrorBoundary\]/],
    },
    {
      name: "shell-ssr-throw",
      message: "holey-shell-ssr-only-error",
      onError: [["rendering", false]],
      printed: /^Error: holey-shell-ssr-only-error$/,
      console: [],
    },
    {
      name: "shell-ssr-throw-bounded",
      message: "holey-shell-ssr-only-error",
      onError: [["rendering", false]],
      printed: /^Error: holey-shell-ssr-only-error$/,
      console: [],
    },
  ];

  for (const c of errorCases) {
    test(`${c.name}: a document load ends where a client navigation does`, async ({
      page,
    }) => {
      const f = fixture();
      await clearOnErrorLog(page, f);
      const before = f.serverOutput?.().length ?? 0;

      const raw = await rawDocument(page, f, c.name);

      expect(raw.status).toBe(500);
      // Once per failure, with the original error.
      await expect.poll(() => onErrorFor(page, f, c.name)).toEqual(c.onError);
      // Printed once where it originated, in dev too.
      await expectPrintedOnce(f, before, c.printed);
      if (!f.production) {
        expectHostOverlay(raw.body, c.message);
        await expectNoHandlerPrint(f, before);
        return;
      }
      expectRecoveryDocument(raw.body, f.production);
      if (c.name === "shell-ppr") {
        expect(raw.headers["x-rango-shell"]).toBe("MISS");
        // Never stored: the next request is a MISS again.
        const again = await rawDocument(page, f, c.name);
        expect(again.status).toBe(500);
        expect(again.headers["x-rango-shell"]).toBe("MISS");
      }
      if (c.console.length > 0) expectConsole(page, { allow: c.console });
      const response = await page.goto(f.url(pathOf(c.name)));
      expect(response?.status()).toBe(500);
      await expectRendered(page);
      await screens[c.name](page);
    });

    test(`${c.name}: the client navigation it is compared with`, async ({
      page,
    }) => {
      const f = fixture();
      if (c.console.length > 0) expectConsole(page, { allow: c.console });
      await navigateFromIndex(page, f, c.name);
      await screens[c.name](page);
    });
  }

  test("shell-not-found: a loader's notFound() answers 404 with the not-found UI, layouts kept", async ({
    page,
  }) => {
    const f = fixture();
    await clearOnErrorLog(page, f);

    const raw = await rawDocument(page, f, "shell-not-found");

    expect(raw.status).toBe(404);
    expectRecoveryDocument(raw.body, f.production);
    const response = await page.goto(f.url(pathOf("shell-not-found")));
    expect(response?.status()).toBe(404);
    await expectRendered(page);
    await screens["shell-not-found"](page);
    // Control flow, not an error.
    expect(await onErrorFor(page, f, "shell-not-found")).toEqual([]);

    await navigateFromIndex(page, f, "shell-not-found");
    await screens["shell-not-found"](page);
  });

  test("shell-not-found: a browser without JavaScript sees the heading, a JavaScript visitor never does", async ({
    browser,
  }) => {
    const f = fixture();
    const noScript = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await noScript.newPage();
      const response = await page.goto(f.url(pathOf("shell-not-found")));
      expect(response?.status()).toBe(404);
      await expect(
        page.getByRole("heading", { name: "Not Found" }),
      ).toBeVisible();
    } finally {
      await noScript.close();
    }

    const page = await (await browser.newContext()).newPage();
    try {
      await page.goto(f.url(pathOf("shell-not-found")));
      await expectRendered(page);
      await expect(page.locator("body > h1")).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  test("shell-redirect: a loader's redirect() without state answers a real redirect", async ({
    page,
  }) => {
    const f = fixture();
    await clearOnErrorLog(page, f);

    const raw = await rawDocument(page, f, "shell-redirect");

    expect(raw.status).toBe(302);
    expect(raw.headers.location).toMatch(/\/holey-throws\/shell-target$/);
    expect(raw.body).toBe("");
    const response = await page.goto(f.url(pathOf("shell-redirect")));
    expect(response?.status()).toBe(200);
    await expectTarget(page, "none");
    expect(await onErrorFor(page, f, "shell-redirect")).toEqual([]);

    await navigateFromIndex(page, f, "shell-redirect");
    await expectTarget(page, "none");
  });

  test("shell-redirect-state: a loader's redirect() with state answers the recovery document, then the client replace carries the state", async ({
    page,
  }) => {
    const f = fixture();

    const raw = await rawDocument(page, f, "shell-redirect-state");

    // 200 like the same redirect inside a <Suspense>: the document, then the
    // client replace.
    expect(raw.status).toBe(200);
    expectRecoveryDocument(raw.body, f.production);
    await page.goto(f.url(pathOf("shell-redirect-state")));
    await expectTarget(page, "carried-by-redirect");

    await navigateFromIndex(page, f, "shell-redirect-state");
    await expectTarget(page, "carried-by-redirect");
  });

  test("shell-hooks: hook readers on a recovered document read its page, then a navigation away and Back work", async ({
    page,
  }) => {
    const f = fixture();
    test.skip(!f.production, "dev answers the host's overlay: nothing to read");

    const response = await page.goto(f.url(pathOf("shell-hooks")));

    expect(response?.status()).toBe(500);
    await expectRendered(page);
    const expectHooks = async (): Promise<void> => {
      await expect(page.getByTestId("holey-shell-pathname")).toHaveText(
        "/holey-throws/shell-hooks",
      );
      await expect(page.getByTestId("holey-shell-nav-state")).toHaveText(
        "idle",
      );
      await expect(page.getByTestId("holey-shell-location-state")).toHaveText(
        "none",
      );
      await expect(page.getByTestId("holey-shell-notes")).toHaveText(
        "from-the-handler",
      );
      await expect(
        page.getByTestId("holey-shell-client-rendered"),
      ).toBeVisible();
    };
    await expectHooks();

    await page.getByTestId("holey-shell-hooks-away").click();
    await expectTarget(page, "none");

    await page.goBack();
    await expect(page).toHaveURL(/\/holey-throws\/shell-hooks$/);
    await expectHooks();
  });

  test("the visitor's theme stays on a recovered document, in every frame", async ({
    page,
    context,
  }) => {
    const f = fixture();
    test.skip(!f.production, "dev answers the host's overlay");
    await context.addCookies([
      { name: "theme", value: "dark", url: f.url("/") },
    ]);
    // Sample <html>'s class before every frame paints, from the first one
    // until 500 ms after the client render.
    await page.addInitScript(() => {
      const frames: string[] = [];
      (window as unknown as { __themeFrames: string[] }).__themeFrames = frames;
      let renderedAt: number | undefined;
      const sample = (now: number): void => {
        frames.push(document.documentElement.className);
        if (document.documentElement.hasAttribute("data-hydrated")) {
          renderedAt ??= now;
        }
        if (renderedAt === undefined || now - renderedAt < 500) {
          requestAnimationFrame(sample);
        }
      };
      requestAnimationFrame(sample);
    });

    await page.goto(f.url(pathOf("shell-ssr-throw")));

    await expectRendered(page);
    await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
    await page.waitForTimeout(700);
    const frames = await page.evaluate(
      () => (window as unknown as { __themeFrames: string[] }).__themeFrames,
    );
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.filter((c) => !/(^|\s)dark(\s|$)/.test(c))).toEqual([]);
  });

  test("an ssr: false loader with no boundary prints its error once", async ({
    page,
  }) => {
    const f = fixture();
    test.skip(!f.serverOutput, "the suite does not own the server process");
    const probe = `print-${randomUUID().slice(0, 8)}`;
    const bump = await page.request.get(
      f.url(`/holey-throws/__bump?probe=${probe}`),
    );
    expect(bump.ok()).toBe(true);
    const before = f.serverOutput!().length;

    const res = await page.request.get(
      f.url(`/holey-throws/document?probe=${probe}`),
      { headers: { Accept: "text/html" } },
    );

    expect(res.status()).toBe(500);
    await expectPrintedOnce(
      f,
      before,
      /^\[RSC\] Loader error \(HoleyThrowsLoader\) \/holey-throws\/document: Error: holey-throws-error@g2$/,
    );
  });

  test("an ssr: false loader whose error a declared errorBoundary() renders prints it once too", async ({
    page,
  }) => {
    const f = fixture();
    test.skip(!f.serverOutput, "the suite does not own the server process");
    const probe = `print-bounded-${randomUUID().slice(0, 8)}`;
    const bump = await page.request.get(
      f.url(`/holey-throws/__bump?probe=${probe}`),
    );
    expect(bump.ok()).toBe(true);
    const before = f.serverOutput!().length;

    const res = await page.request.get(
      f.url(`/holey-throws/bounded?probe=${probe}`),
      { headers: { Accept: "text/html" } },
    );

    expect(res.status()).toBe(500);
    await expectPrintedOnce(
      f,
      before,
      /^\[RSC\] Loader error \(HoleyThrowsLoader\) \/holey-throws\/bounded: Error: holey-throws-error@g2$/,
    );
  });
}
