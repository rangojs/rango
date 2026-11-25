import { expect, test, type Page } from "@playwright/test";
import { expectConsole } from "./console-guard.js";

/**
 * `<Outlet keep />`: a page the outlet leaves stays mounted and hidden, and
 * coming back shows the same instance.
 *
 * Fixture in each app (kept-pages.tsx, kept-pages.client.tsx):
 *  - /kept-pages/:id (a, b, c) under a server layout with
 *    `<Outlet keep={{ max: 1 }} />`; each page sets its title to "Kept <id>".
 *  - /kept-pages-group/x and /y, a clientUrls() group whose layout keeps one.
 *  - /kept-pages-drift/:id, a layout that passes `keep` on the server only.
 * Every page renders KeptPage: a sideways-scrolling strip, an input, a
 * counter, an `@starting-style` entrance, its usePathname() and useKept()
 * as data attributes, and it logs its ref-guarded effect and useKeptShow()
 * to window.__keepLog.
 */

export interface KeptPagesScenarioOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
  expectNoPageError: (page: Page) => Disposable;
  /** Dev logs React's hydration diff; a build logs its minified error. */
  mode: "dev" | "build";
}

type KeptWindow = {
  __keepLog?: string[];
  __keptNodes?: Element[];
  __keptScrolls?: number;
  __keptFrames?: string[];
  __keptSampling?: boolean;
};

const nextFrames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

async function open(
  page: Page,
  options: KeptPagesScenarioOptions,
  path: string,
  shown: string,
): Promise<void> {
  await page.goto(options.url(path));
  await options.waitForHydration(page);
  await expect(page.getByTestId(`kept-${shown}`)).toBeVisible();
}

async function go(page: Page, link: string, shown: string): Promise<void> {
  await page.getByTestId(link).click();
  await expect(page.getByTestId(`kept-${shown}`)).toBeVisible();
}

export function runKeptPagesTests(options: KeptPagesScenarioOptions): void {
  for (const shape of [
    {
      name: "server routes",
      path: "/kept-pages/a",
      a: "a",
      b: "b",
      toA: "kept-to-a",
      toB: "kept-to-b",
    },
    {
      name: "a clientUrls() group",
      path: "/kept-pages-group/x",
      a: "x",
      b: "y",
      toA: "kept-group-to-x",
      toB: "kept-group-to-y",
    },
  ]) {
    test(`${shape.name}: a page shown again keeps its state, scroll and DOM nodes, with no scroll event`, async ({
      page,
    }) => {
      using _ = options.expectNoPageError(page);
      await open(page, options, shape.path, shape.a);
      await page.getByTestId(`kept-input-${shape.a}`).fill("typed");
      await page.getByTestId(`kept-count-${shape.a}`).click();
      await page.getByTestId(`kept-strip-${shape.a}`).evaluate((el) => {
        el.scrollLeft = 300;
      });
      await page.evaluate((id) => {
        const section = document.querySelector(`[data-testid="kept-${id}"]`)!;
        (window as KeptWindow).__keptNodes = [
          section,
          ...section.querySelectorAll("*"),
        ];
      }, shape.a);

      await go(page, shape.toB, shape.b);
      await expect(page.getByTestId(`kept-${shape.a}`)).toBeHidden();
      await page.getByTestId(`kept-strip-${shape.a}`).evaluate((el) => {
        (window as KeptWindow).__keptScrolls = 0;
        el.addEventListener("scroll", () => {
          (window as KeptWindow).__keptScrolls! += 1;
        });
      });

      await go(page, shape.toA, shape.a);
      await nextFrames(page);
      await expect(page.getByTestId(`kept-input-${shape.a}`)).toHaveValue(
        "typed",
      );
      await expect(page.getByTestId(`kept-count-${shape.a}`)).toHaveText("1");
      expect(
        await page
          .getByTestId(`kept-strip-${shape.a}`)
          .evaluate((el) => el.scrollLeft),
      ).toBe(300);
      expect(
        await page.evaluate(() => (window as KeptWindow).__keptScrolls),
      ).toBe(0);
      const sameNodes = await page.evaluate((id) => {
        const before = (window as KeptWindow).__keptNodes!;
        const section = document.querySelector(`[data-testid="kept-${id}"]`)!;
        const now = [section, ...section.querySelectorAll("*")];
        return (
          before.length === now.length &&
          before.every((node, index) => node === now[index] && node.isConnected)
        );
      }, shape.a);
      expect(sameNodes).toBe(true);
    });

    test(`${shape.name}: a hidden page reads its own pathname, and a show runs useKeptShow and its effects again`, async ({
      page,
    }) => {
      using _ = options.expectNoPageError(page);
      await open(page, options, shape.path, shape.a);
      await go(page, shape.toB, shape.b);
      const ownPath = new URL(options.url(shape.path)).pathname;
      await expect(page.getByTestId(`kept-${shape.a}`)).toHaveAttribute(
        "data-path",
        ownPath,
      );
      await expect(page.getByTestId(`kept-${shape.a}`)).toHaveAttribute(
        "data-hidden",
        "true",
      );
      const beforeShow = await page.evaluate(
        () => (window as KeptWindow).__keepLog ?? [],
      );
      expect(beforeShow.filter((line) => line.startsWith("show"))).toEqual([]);

      await page.evaluate(() => {
        (window as KeptWindow).__keepLog = [];
      });
      await go(page, shape.toA, shape.a);
      await expect
        .poll(() => page.evaluate(() => (window as KeptWindow).__keepLog))
        .toEqual(
          expect.arrayContaining([
            `effect ${shape.a} again`,
            `show ${shape.a}`,
          ]),
        );
      const shows = await page.evaluate(() =>
        (window as KeptWindow).__keepLog!.filter((line) =>
          line.startsWith("show"),
        ),
      );
      expect(shows).toEqual([`show ${shape.a}`]);
      await expect(page.getByTestId(`kept-${shape.a}`)).toHaveAttribute(
        "data-hidden",
        "false",
      );
    });

    test(`${shape.name}: a show replays no @starting-style entrance`, async ({
      page,
    }) => {
      using _ = options.expectNoPageError(page);
      await open(page, options, shape.path, shape.a);
      await go(page, shape.toB, shape.b);
      await go(page, shape.toA, shape.a);
      const running = await page
        .getByTestId(`kept-enter-${shape.a}`)
        .evaluate(
          (el) =>
            el
              .getAnimations()
              .filter(
                (animation) =>
                  animation instanceof CSSTransition &&
                  animation.playState === "running",
              ).length,
        );
      expect(running).toBe(0);
    });

    test(`${shape.name}: the document is the page alone, in a visible Activity`, async ({
      request,
    }) => {
      const html = await (await request.get(options.url(shape.path))).text();
      expect(html).toContain(`data-testid="kept-${shape.a}"`);
      expect(html).toContain("<!--&-->");
      expect(html).not.toContain(`data-testid="kept-${shape.b}"`);
    });
  }

  test("server routes: max counts hidden pages; the one left longest ago mounts anew", async ({
    page,
  }) => {
    using _ = options.expectNoPageError(page);
    await open(page, options, "/kept-pages/a", "a");
    await page.getByTestId("kept-input-a").fill("A");
    await go(page, "kept-to-b", "b");
    await page.getByTestId("kept-input-b").fill("B");
    await go(page, "kept-to-c", "c");
    await expect(page.getByTestId("kept-a")).toHaveCount(0);
    await go(page, "kept-to-a", "a");
    await expect(page.getByTestId("kept-input-a")).toHaveValue("");
    await go(page, "kept-to-b", "b");
    await expect(page.getByTestId("kept-input-b")).toHaveValue("");
    await go(page, "kept-to-a", "a");
    await expect(page.getByTestId("kept-input-a")).toHaveValue("");
  });

  test("server routes: no frame shows a kept page under the page it left's title", async ({
    page,
  }) => {
    using _ = options.expectNoPageError(page);
    await open(page, options, "/kept-pages/a", "a");
    await go(page, "kept-to-b", "b");
    await expect(page).toHaveTitle("Kept b");
    await page.evaluate(() => {
      const probe = window as KeptWindow;
      probe.__keptFrames = [];
      probe.__keptSampling = true;
      const sample = () => {
        const visible = document.querySelector(
          '[data-testid="kept-a"]:not([data-hidden="true"])',
        );
        probe.__keptFrames!.push(`${visible ? "a" : "-"}|${document.title}`);
        if (probe.__keptSampling) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await go(page, "kept-to-a", "a");
    await expect(page).toHaveTitle("Kept a");
    await nextFrames(page);
    const frames = await page.evaluate(() => {
      const probe = window as KeptWindow;
      probe.__keptSampling = false;
      return probe.__keptFrames!;
    });
    expect(frames.filter((frame) => frame.startsWith("a|"))).not.toContain(
      "a|Kept b",
    );
  });

  test("server routes: showing a kept page fetches no more than a mount, and Back to one fetches nothing", async ({
    page,
  }) => {
    using _ = options.expectNoPageError(page);
    await open(page, options, "/kept-pages/a", "a");
    let requests = 0;
    page.on("request", (request) => {
      if (request.url().includes("_rsc")) requests += 1;
    });
    await go(page, "kept-to-b", "b");
    await nextFrames(page);
    const mount = requests;
    expect(mount).toBeGreaterThan(0);
    requests = 0;
    await go(page, "kept-to-a", "a");
    await nextFrames(page);
    expect(requests).toBeLessThanOrEqual(mount);
    requests = 0;
    await page.goBack();
    await expect(page.getByTestId("kept-b")).toBeVisible();
    await nextFrames(page);
    expect(requests).toBe(0);
  });

  test("keep on the server and not in the browser fails loudly, naming the outlet", async ({
    page,
  }) => {
    // Provoked on purpose (console guard, console-guard.ts).
    expectConsole(page, {
      allow: [/Hydration failed|Minified React error #418|hydrat/i],
    });
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(options.url("/kept-pages-drift/a"));
    await expect(page.getByTestId("kept-a")).toBeVisible();
    await expect
      .poll(() => errors.join("\n"))
      .toMatch(
        options.mode === "dev"
          ? /Hydration failed[\s\S]*KeptDriftOutlet/
          : /Minified React error #418|Hydration/,
      );
  });
}
