import { expect, test, type Page } from "@playwright/test";

/**
 * Async handle values (#1174): a handle pushed with a promise (or an async
 * function) is awaited during SSR, so the document ships the resolved value,
 * and on a client navigation the previous value is held until the promise
 * resolves, then swapped, without holding the page. Fixture in each app:
 * /async-handles/* (test-app urls/async-handles.tsx, cloudflare-basic
 * pages/async-handles.tsx), behind a 400 ms server-delay middleware. The
 * handles resolve 800 ms after the page's content.
 *
 * An init script logs (title, last fixture crumb, page marker) after each DOM
 * mutation batch (window.__ahLog). The analytics reader (AhAnalytics in the
 * fixture's client file) pushes {pathname, title} into window.__pageViews.
 */

export interface AsyncHandlesScenarioOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
}

interface Shown {
  t: number;
  title: string;
  crumb: string | null;
  page: string | null;
}

type ProbeWindow = {
  __ahLog?: Shown[];
  __ahClick?: number;
  __titleViews?: { title: string; doc: string }[];
  __pathTitleViews?: { pathname: string; title: string }[];
};

const NAV_TIMEOUT = 10000;
const HTML = { accept: "text/html" };

async function installLog(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as ProbeWindow;
    w.__ahLog = [];
    const record = (): void => {
      const crumbs = document.querySelectorAll('[data-testid="ah-crumb"]');
      const shown = {
        t: performance.now(),
        title: document.title,
        crumb: crumbs[crumbs.length - 1]?.textContent ?? null,
        page:
          document.querySelector('[data-testid="ah-page"]')?.textContent ??
          null,
      };
      const last = w.__ahLog![w.__ahLog!.length - 1];
      if (
        last &&
        last.title === shown.title &&
        last.crumb === shown.crumb &&
        last.page === shown.page
      ) {
        return;
      }
      w.__ahLog!.push(shown);
    };
    new MutationObserver(record).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    document.addEventListener(
      "click",
      () => {
        w.__ahClick = performance.now();
        w.__ahLog = [];
        record();
      },
      true,
    );
  });
}

const testId = (page: Page, id: string) =>
  page.locator(`[data-testid="${id}"]`);

export function runAsyncHandlesTests(
  options: AsyncHandlesScenarioOptions,
): void {
  for (const variant of ["urgent", "fn"] as const) {
    test(`${variant}: SSR awaits the pushed promise, the document ships the resolved title and crumb`, async ({
      request,
    }) => {
      const response = await request.get(
        options.url(`/async-handles/${variant}/1`),
        { headers: HTML },
      );
      const html = await response.text();
      expect(html).toContain(`<title>AH ${variant} 1</title>`);
      expect(html).toMatch(
        new RegExp(
          `data-testid="ah-crumb"[^>]*>(<!-- -->)?${variant} 1(<!-- -->)?</li>`,
        ),
      );
    });
  }

  for (const variant of ["urgent", "transition"] as const) {
    test(`${variant}: client navigation holds the previous title and crumb until the promise resolves, the page is not held`, async ({
      page,
    }) => {
      await installLog(page);
      await page.goto(options.url(`/async-handles/${variant}/1`));
      await options.waitForHydration(page);
      await expect(page).toHaveTitle(`AH ${variant} 1`);

      await testId(page, "ah-link-2").click();
      await expect(testId(page, "ah-page")).toHaveText(`${variant} 2`, {
        timeout: NAV_TIMEOUT,
      });
      await expect(page).toHaveTitle(`AH ${variant} 2`, {
        timeout: NAV_TIMEOUT,
      });
      await expect(testId(page, "ah-crumb").last()).toHaveText(`${variant} 2`, {
        timeout: NAV_TIMEOUT,
      });

      const { log, click } = await page.evaluate(() => {
        const w = window as unknown as ProbeWindow;
        return { log: w.__ahLog ?? [], click: w.__ahClick ?? 0 };
      });
      const trace = JSON.stringify(log, null, 1);
      const from = `AH ${variant} 1`;
      const to = `AH ${variant} 2`;

      // Never blank, the default, or a placeholder in between.
      for (const shown of log) {
        expect([from, to], trace).toContain(shown.title);
        expect(shown.crumb, trace).not.toBeNull();
      }
      const pageAt = log.find((s) => s.page === `${variant} 2`);
      const titleAt = log.find((s) => s.title === to);
      const crumbAt = log.find((s) => s.crumb === `${variant} 2`);
      expect(pageAt, trace).toBeDefined();
      expect(titleAt, trace).toBeDefined();
      expect(crumbAt, trace).toBeDefined();
      // The body shows before the meta resolves, over the previous title.
      expect(pageAt!.title, trace).toBe(from);
      expect(pageAt!.crumb, trace).toBe(`${variant} 1`);
      expect(titleAt!.t, trace).toBeGreaterThan(pageAt!.t);
      // The new title never shows over the page being left.
      expect(
        log.filter((s) => s.title === to && s.page !== `${variant} 2`),
        trace,
      ).toEqual([]);
      test.info().annotations.push({
        type: "async-handles",
        description: `page +${Math.round(pageAt!.t - click)} ms, title +${Math.round(titleAt!.t - click)} ms after the click`,
      });
    });

    test(`${variant}: an effect keyed on [title] reads the resolved title, never a stale one`, async ({
      page,
    }) => {
      await installLog(page);
      await page.goto(options.url(`/async-handles/${variant}/1`));
      await options.waitForHydration(page);
      await expect(page).toHaveTitle(`AH ${variant} 1`);

      await testId(page, "ah-link-2").click();
      await expect(page).toHaveTitle(`AH ${variant} 2`, {
        timeout: NAV_TIMEOUT,
      });
      await page.waitForTimeout(1500);

      const views = await page.evaluate(
        () => (window as unknown as ProbeWindow).__titleViews ?? [],
      );
      const trace = JSON.stringify(views, null, 1);
      // The mount effect of the first page may run twice (StrictMode in dev).
      const titles = views.map((v) => v.title);
      for (const title of titles) {
        expect([`AH ${variant} 1`, `AH ${variant} 2`], trace).toContain(title);
      }
      expect(titles[titles.length - 1], trace).toBe(`AH ${variant} 2`);
      expect(
        titles.filter((title) => title === `AH ${variant} 2`),
        trace,
      ).toHaveLength(1);
      // Each reported title is the one the document shows when the effect runs.
      for (const v of views) expect(v.doc, trace).toBe(v.title);
    });
  }

  // Recorded, not pinned: what an effect keyed on [pathname, title] reports.
  for (const variant of ["sync", "urgent", "transition"] as const) {
    test(`${variant}: records what an effect keyed on [pathname, title] reports`, async ({
      page,
    }) => {
      await installLog(page);
      await page.goto(options.url(`/async-handles/${variant}/1`));
      await options.waitForHydration(page);
      await expect(page).toHaveTitle(`AH ${variant} 1`);
      await page.evaluate(() => {
        (window as unknown as ProbeWindow).__pathTitleViews = [];
      });

      await testId(page, "ah-link-2").click();
      await expect(page).toHaveTitle(`AH ${variant} 2`, {
        timeout: NAV_TIMEOUT,
      });
      await page.waitForTimeout(1500);

      const views = await page.evaluate(
        () => (window as unknown as ProbeWindow).__pathTitleViews ?? [],
      );
      const description = `${views.length} fire(s) after 1 -> 2: ${JSON.stringify(views)}`;
      test.info().annotations.push({ type: "path-title", description });
      console.log(
        `[async-handles] ${variant} [pathname,title]: ${description}`,
      );
    });
  }

  test("late: a promise resolving after the page updates the title and crumb in place, without remounting the page", async ({
    page,
  }) => {
    await installLog(page);
    await page.goto(options.url("/async-handles/late/1"));
    await options.waitForHydration(page);
    await expect(page).toHaveTitle("AH late 1");

    await testId(page, "ah-link-2").click();
    await expect(testId(page, "ah-page")).toHaveText("late 2", {
      timeout: NAV_TIMEOUT,
    });
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="ah-page"]')!;
      (el as unknown as { __mark?: boolean }).__mark = true;
    });
    // The page is up, the title is still the previous one.
    expect(await page.title()).toBe("AH late 1");

    await expect(page).toHaveTitle("AH late 2", { timeout: NAV_TIMEOUT });
    await expect(testId(page, "ah-crumb").last()).toHaveText("late 2", {
      timeout: NAV_TIMEOUT,
    });
    const survived = await page.evaluate(
      () =>
        (
          document.querySelector('[data-testid="ah-page"]') as unknown as {
            __mark?: boolean;
          }
        )?.__mark === true,
    );
    const log = await page.evaluate(
      () => (window as unknown as ProbeWindow).__ahLog ?? [],
    );
    const trace = JSON.stringify(log, null, 1);
    expect(survived, trace).toBe(true);
    const pageAt = log.findIndex((s) => s.page === "late 2");
    expect(pageAt, trace).toBeGreaterThanOrEqual(0);
    // Once up, the page never disappears (no fallback, no remount).
    expect(
      log.slice(pageAt).filter((s) => s.page !== "late 2"),
      trace,
    ).toEqual([]);
    for (const shown of log) {
      expect(["AH late 1", "AH late 2"], trace).toContain(shown.title);
    }
  });
}
