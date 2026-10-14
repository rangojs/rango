import { expect, test, type Page } from "@playwright/test";

/**
 * A navigation's title and crumbs commit with its page, never over the page
 * being left. Fixture in each app: /handles-commit/* (test-app
 * urls/handles-commit.tsx, cloudflare-basic pages/handles-commit.tsx), behind
 * a 400 ms server-delay middleware.
 *
 * An init script logs what the document shows after each DOM mutation batch
 * (window.__hcLog): the title, the last fixture crumb, the pathname a
 * useSegments() reader shows, the page, and the crumb content. A React commit mutates the DOM in one task, so one entry is
 * one commit, or two commits in the same task.
 *
 * The title, the crumb and the segments never show the destination over the
 * page being left.
 *
 * - held/:id, held-novt/:id: the handler pushes its title and crumb, then
 *   waits 800 ms before it returns the page (loading(), transition() with and
 *   without the router's <ViewTransition>). The handles reach the client
 *   about 800 ms before the page.
 * - stream/:boundary/:id, stream-vt/...: the page renders at once, and its
 *   crumb's content is a 2 s promise read with use() in <Suspense>. "same"
 *   keeps the crumb's boundary mounted across pages, "keyed" mounts a new
 *   one. The page changes with the response; only the crumb content waits.
 */

export interface HandlesCommitScenarioOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
}

interface Shown {
  t: number;
  title: string;
  crumb: string | null;
  segments: string | null;
  page: string | null;
  content: string | null;
}

type ProbeWindow = { __hcLog?: Shown[]; __hcClick?: number };

const NAV_TIMEOUT = 10000;

async function installLog(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as ProbeWindow;
    w.__hcLog = [];
    const text = (selector: string): string | null =>
      document.querySelector(selector)?.textContent ?? null;
    const record = (): void => {
      const crumbs = document.querySelectorAll('[data-testid="hc-crumb"]');
      const shown = {
        t: performance.now(),
        title: document.title,
        crumb: crumbs[crumbs.length - 1]?.textContent ?? null,
        segments: text('[data-testid="hc-segments"]'),
        page: text('[data-testid="hc-page"]'),
        content: text(
          '[data-testid="hc-trail"] [data-testid="hc-crumb-content"]',
        ),
      };
      const last = w.__hcLog![w.__hcLog!.length - 1];
      if (
        last &&
        last.title === shown.title &&
        last.crumb === shown.crumb &&
        last.segments === shown.segments &&
        last.page === shown.page &&
        last.content === shown.content
      ) {
        return;
      }
      w.__hcLog!.push(shown);
    };
    new MutationObserver(record).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    document.addEventListener(
      "click",
      () => {
        w.__hcClick = performance.now();
        w.__hcLog = [];
        record();
      },
      true,
    );
  });
}

async function readLog(page: Page): Promise<{ log: Shown[]; click: number }> {
  return page.evaluate(() => {
    const w = window as unknown as ProbeWindow;
    return { log: w.__hcLog ?? [], click: w.__hcClick ?? 0 };
  });
}

const testId = (page: Page, id: string) =>
  page.locator(`[data-testid="${id}"]`);

// The app's own breadcrumb nav renders the crumb content too.
const crumbContent = (page: Page) =>
  page.locator('[data-testid="hc-trail"] [data-testid="hc-crumb-content"]');

async function expectShown(
  page: Page,
  title: string,
  crumb: string,
  body: string,
): Promise<void> {
  await expect(testId(page, "hc-page")).toHaveText(body, {
    timeout: NAV_TIMEOUT,
  });
  await expect(page).toHaveTitle(title, { timeout: NAV_TIMEOUT });
  await expect(testId(page, "hc-crumb").last()).toHaveText(crumb, {
    timeout: NAV_TIMEOUT,
  });
}

/**
 * No logged state shows the destination's title, crumb or segments over
 * another page.
 */
function expectHandlesWithPage(
  log: Shown[],
  dest: { title: string; crumb: string; segments: string; page: string },
): void {
  const early = log.filter(
    (shown) =>
      (shown.title === dest.title ||
        shown.crumb === dest.crumb ||
        shown.segments === dest.segments) &&
      shown.page !== dest.page,
  );
  expect(early, JSON.stringify(log, null, 1)).toEqual([]);
}

export function runHandlesCommitTests(
  options: HandlesCommitScenarioOptions,
): void {
  const open = async (page: Page, pathname: string): Promise<void> => {
    await installLog(page);
    await page.goto(options.url(pathname));
    await options.waitForHydration(page);
  };

  for (const variant of ["held", "held-novt"] as const) {
    test(`${variant}: the title and the last crumb never show over the page being left`, async ({
      page,
    }) => {
      await open(page, `/handles-commit/${variant}/1`);
      await expectShown(
        page,
        `HC ${variant} 1`,
        `${variant} 1`,
        `${variant} 1`,
      );

      for (const id of ["2", "3"]) {
        await testId(page, `hc-link-${id}`).click();
        const dest = {
          title: `HC ${variant} ${id}`,
          crumb: `${variant} ${id}`,
          segments: `/handles-commit/${variant}/${id}`,
          page: `${variant} ${id}`,
        };
        await expectShown(page, dest.title, dest.crumb, dest.page);
        const { log } = await readLog(page);
        expectHandlesWithPage(log, dest);
        // transition(): the page being left stays until the destination
        // commits, so its loading() skeleton never shows.
        expect(log.some((shown) => shown.page === null)).toBe(false);
      }
    });
  }

  for (const variant of ["stream", "stream-vt"] as const) {
    for (const boundary of ["same", "keyed"] as const) {
      test(`${variant}, ${boundary} crumb boundary: the page changes with the response, only the crumb content waits`, async ({
        page,
      }) => {
        const base = `/handles-commit/${variant}/${boundary}`;
        await open(page, `${base}/1`);
        await expect(crumbContent(page)).toHaveText("stock 1", {
          timeout: NAV_TIMEOUT,
        });

        await testId(page, "hc-link-2").click();
        const dest = {
          title: `HC ${variant} ${boundary} 2`,
          crumb: `${boundary} 2`,
          segments: `${base}/2`,
          page: `${boundary} 2`,
        };
        await expectShown(page, dest.title, dest.crumb, dest.page);
        await expect(crumbContent(page)).toHaveText("stock 2", {
          timeout: NAV_TIMEOUT,
        });

        const { log, click } = await readLog(page);
        const trace = JSON.stringify(log, null, 1);
        expectHandlesWithPage(log, dest);
        const pageAt = log.find((shown) => shown.page === dest.page);
        const contentAt = log.find((shown) => shown.content === "stock 2");
        expect(pageAt, trace).toBeDefined();
        expect(contentAt, trace).toBeDefined();
        // The content resolves 2 s after the server starts the page. The page
        // commits with the response: without the crumb content, well before it.
        expect(pageAt!.content, trace).not.toBe("stock 2");
        test.info().annotations.push({
          type: "handles-commit",
          description: `page +${Math.round(pageAt!.t - click)} ms, content +${Math.round(contentAt!.t - click)} ms after the click`,
        });
      });
    }
  }
}
