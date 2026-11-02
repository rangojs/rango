import { expect, test, type Page } from "@playwright/test";

/**
 * A refreshed useLoader value (load()) belongs to the route data it was
 * requested for. A reader shows it only while its own route data is that
 * data: a reader that mounts on another page, or on a new visit to the same
 * page, draws the data its navigation brought, from its first frame; a
 * reader held across a navigation that brings new data draws that data in
 * the navigation's commit. Back onto a cached page restores that page's
 * route data, so its refresh shows again.
 *
 * Fixture in each app, under `base`: a layout with links (lr-link-*) over
 * pages a and b, which register a fetchable loader (400 ms on the server)
 * whose value is `<page>:<run>`; a page `none` without it; and page vt,
 * which registers it under transition(). Each loader page renders the
 * loader's value from the server (lr-marker) beside a client reader of the
 * same loader with a refresh key (lr-value, lr-loading, lr-error,
 * lr-refresh, and lr-slow-refresh: a load() the server answers after
 * 1500 ms). The loader pages revalidate on every navigation, so the marker
 * and the reader commit together, and a frame whose
 * reader differs from its marker is a reader drawing another page's data.
 */

export interface LoaderRemountRefreshScenarioOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
  expectNoPageError: (page: Page) => Disposable;
  /** Path prefix of the fixture's pages, e.g. "/loader-remount". */
  base: string;
}

interface Frame {
  marker: string | null;
  value: string | null;
  loading: string | null;
  instance: string | null;
}
type ProbeWindow = {
  __lrFrames?: Frame[];
  __lrObserver?: MutationObserver;
};

const VALUE = /^[a-z]+:\d+$/;

const testId = (page: Page, id: string) =>
  page.locator(`[data-testid="${id}"]`);

/**
 * Records the marker and the reader after every DOM mutation from now on:
 * each React commit is one observer callback, so this is the screen, commit
 * by commit.
 */
async function recordFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as ProbeWindow;
    w.__lrObserver?.disconnect();
    const frames: Frame[] = [];
    w.__lrFrames = frames;
    const text = (id: string) =>
      document.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
    const snap = () => {
      frames.push({
        marker: text("lr-marker"),
        value: text("lr-value"),
        loading: text("lr-loading"),
        instance:
          document
            .querySelector('[data-testid="lr-reader"]')
            ?.getAttribute("data-instance") ?? null,
      });
    };
    snap();
    w.__lrObserver = new MutationObserver(snap);
    w.__lrObserver.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-instance"],
    });
  });
}

async function readFrames(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    const w = window as unknown as ProbeWindow;
    w.__lrObserver?.disconnect();
    return w.__lrFrames ?? [];
  });
}

/** The frames a page other than `left` was on screen in, with a reader. */
function framesAfter(frames: Frame[], left: string): Frame[] {
  return frames.filter(
    (f) => f.marker !== null && f.marker !== left && f.value !== null,
  );
}

/**
 * The reader settled on its own route data, and its marker. `left` is the
 * marker of the page being left, so the old page's marker is not taken for
 * the new one's before the navigation commits.
 */
async function settledOnRouteData(
  page: Page,
  left: string | null = null,
): Promise<string> {
  const handle = await page.waitForFunction(
    ([pattern, previous]) => {
      const text =
        document.querySelector('[data-testid="lr-marker"]')?.textContent ?? "";
      return new RegExp(pattern!).test(text) && text !== previous ? text : null;
    },
    [VALUE.source, left] as const,
  );
  const value = (await handle.jsonValue()) as string;
  await expect(testId(page, "lr-value")).toHaveText(value);
  return value;
}

export function runLoaderRemountRefreshTests(
  options: LoaderRemountRefreshScenarioOptions,
): void {
  const { base } = options;

  /** Opens page `name`, refreshes its reader, returns [marker, refreshed]. */
  async function openRefreshed(
    page: Page,
    name: string,
  ): Promise<[string, string]> {
    await page.goto(options.url(`${base}/${name}`));
    await options.waitForHydration(page);
    const marker = await settledOnRouteData(page);
    await testId(page, "lr-refresh").click();
    const value = testId(page, "lr-value");
    await expect(value).not.toHaveText(marker);
    await expect(value).toHaveText(new RegExp(`^${name}:\\d+$`));
    await expect(testId(page, "lr-loading")).toHaveText("false");
    return [marker, (await value.textContent())!];
  }

  async function goTo(page: Page, link: string): Promise<void> {
    await testId(page, `lr-link-${link}`).click();
  }

  /** Every frame of the page reached since `left` shows its own route data. */
  function expectOwnRouteData(frames: Frame[], left: string): void {
    const shown = framesAfter(frames, left);
    expect(shown.length).toBeGreaterThan(0);
    for (const frame of shown) {
      expect(frame, JSON.stringify(frames)).toMatchObject({
        value: frame.marker,
      });
    }
  }

  test("a refreshed reader's data does not reach the next page's reader through a page without the loader", async ({
    page,
  }) => {
    using _ = options.expectNoPageError(page);
    const [marker] = await openRefreshed(page, "a");

    await goTo(page, "none");
    await expect(testId(page, "lr-none")).toBeVisible();
    await recordFrames(page);
    await goTo(page, "b");
    const b = await settledOnRouteData(page, marker);
    expect(b).toMatch(/^b:/);
    expectOwnRouteData(await readFrames(page), marker);
  });

  test("a refreshed reader's data does not reach the next page's reader", async ({
    page,
  }) => {
    using _ = options.expectNoPageError(page);
    const [marker] = await openRefreshed(page, "a");

    await recordFrames(page);
    await goTo(page, "b");
    const b = await settledOnRouteData(page, marker);
    expect(b).toMatch(/^b:/);
    expectOwnRouteData(await readFrames(page), marker);
  });

  test("a new visit to a refreshed page shows that visit's data", async ({
    page,
  }) => {
    using _ = options.expectNoPageError(page);
    const [marker, refreshed] = await openRefreshed(page, "a");

    await goTo(page, "none");
    await expect(testId(page, "lr-none")).toBeVisible();
    await recordFrames(page);
    await goTo(page, "a");
    const again = await settledOnRouteData(page);
    expect(again).not.toBe(marker);
    expect(again).not.toBe(refreshed);
    expectOwnRouteData(await readFrames(page), marker);
  });

  test("a load() still in flight when the user leaves does not land on the next page", async ({
    page,
  }) => {
    using _ = options.expectNoPageError(page);
    await page.goto(options.url(`${base}/a`));
    await options.waitForHydration(page);
    const marker = await settledOnRouteData(page);

    const slowAnswer = page.waitForResponse((r) =>
      r.url().includes("_rsc_loader"),
    );
    await testId(page, "lr-slow-refresh").click();
    await expect(testId(page, "lr-loading")).toHaveText("true");
    await goTo(page, "none");
    await expect(testId(page, "lr-none")).toBeVisible();
    await recordFrames(page);
    await goTo(page, "b");
    const b = await settledOnRouteData(page, marker);
    await expect(testId(page, "lr-loading")).toHaveText("false");
    // The slow answer arrived and had a frame to land in.
    await (await slowAnswer).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(testId(page, "lr-value")).toHaveText(b);
    await expect(testId(page, "lr-error")).toHaveText("");
    const frames = framesAfter(await readFrames(page), marker);
    expectOwnRouteData(frames, marker);
    for (const frame of frames) {
      expect(frame.loading, JSON.stringify(frames)).toBe("false");
    }
  });

  test("Back to a page refreshed before it was left shows the refresh", async ({
    page,
  }) => {
    using _ = options.expectNoPageError(page);
    const [marker, refreshed] = await openRefreshed(page, "a");

    await goTo(page, "none");
    await expect(testId(page, "lr-none")).toBeVisible();
    await page.goBack();
    await expect(testId(page, "lr-marker")).toHaveText(marker);
    await expect(testId(page, "lr-value")).toHaveText(refreshed);
  });

  for (const variant of [
    { name: "a", link: "a-next", title: "" },
    { name: "vt", link: "vt-next", title: " under transition()" },
  ]) {
    test(`a reader held across a navigation that brings new data shows it in the commit${variant.title}`, async ({
      page,
    }) => {
      using _ = options.expectNoPageError(page);
      const [marker, refreshed] = await openRefreshed(page, variant.name);
      const instance = await testId(page, "lr-reader").getAttribute(
        "data-instance",
      );

      await recordFrames(page);
      await goTo(page, variant.link);
      const next = await settledOnRouteData(page, marker);
      expect(next).not.toBe(marker);
      expect(next).not.toBe(refreshed);
      const frames = await readFrames(page);
      expectOwnRouteData(frames, marker);
      // The same reader throughout: held, not remounted.
      for (const frame of frames) {
        expect(frame.instance, JSON.stringify(frames)).toBe(instance);
      }
    });
  }
}
