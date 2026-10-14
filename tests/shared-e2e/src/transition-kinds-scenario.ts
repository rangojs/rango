import { expect, test, type Page } from "@playwright/test";
import {
  countViewTransitions,
  viewTransitionTypes,
  viewTransitions,
} from "./view-transition-probe.js";

/**
 * #1165: every commit the router runs in a transition carries its
 * transition({ when }) kind (push, replace, pop, action, revalidate) as a
 * transition type, before the types it carried already. Fixture:
 * /vt-kinds/<variant>/* in each app (test-app urls/transition-kinds.tsx,
 * cloudflare-basic pages/transition-kinds.tsx). The probe <ViewTransition>
 * records the types its event callbacks receive (window.__vtKinds), and
 * countViewTransitions the types of each document.startViewTransition call.
 *
 * React keeps one queue of transition types per root, and the first
 * transition-only commit after a startTransition takes all of it (react-dom
 * queueTransitionTypes, claimQueuedTransitionTypes). Every route-state hook
 * update commits with the page (useNavigation #1164, useHandle and
 * useSegments through their commit anchor), so the page's commit is the one
 * that takes them: each step expects exactly its kind's types.
 */

export interface TransitionKindsScenarioOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
}

const testId = (page: Page, id: string) =>
  page.locator(`[data-testid="${id}"]`);

/** The types of each recorded probe event, in order. */
async function kinds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    ((window as unknown as { __vtKinds?: string[] }).__vtKinds ?? []).map(
      (entry) => entry.slice(entry.indexOf(":") + 1),
    ),
  );
}

/** Run `act`; resolve once the page shows `path` with a new stamp. */
async function commit(
  page: Page,
  act: () => Promise<unknown>,
  path: string,
): Promise<void> {
  const before = await testId(page, "vt-kinds-stamp").textContent();
  await act();
  await expect(testId(page, "vt-kinds-path")).toHaveText(path, {
    timeout: 8000,
  });
  await expect(testId(page, "vt-kinds-stamp")).not.toHaveText(before ?? "", {
    timeout: 8000,
  });
}

async function runAction(page: Page, count: number): Promise<void> {
  const before = await testId(page, "vt-kinds-stamp").textContent();
  await testId(page, "vt-kinds-action").click();
  await expect(testId(page, "vt-kinds-action")).toHaveText(`actions:${count}`, {
    timeout: 8000,
  });
  await expect(testId(page, "vt-kinds-stamp")).not.toHaveText(before ?? "", {
    timeout: 8000,
  });
}

// Two animation frames and a short tail: a late view transition would start
// in the commit that changed the page, not after it.
function settle(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => setTimeout(resolve, 150)),
        ),
      ),
  );
}

export function runTransitionKindsTests(
  options: TransitionKindsScenarioOptions,
): void {
  const open = async (page: Page, pathname: string): Promise<void> => {
    await countViewTransitions(page);
    await page.goto(options.url(pathname));
    await options.waitForHydration(page);
    await expect(testId(page, "vt-kinds-path")).toHaveText(pathname);
  };

  /**
   * Run `step`; the probe records one commit, with exactly `types`, and the
   * page's commit starts one view transition whose types are `types`.
   */
  const expectStep = async (
    page: Page,
    step: () => Promise<void>,
    types: string,
  ): Promise<void> => {
    const before = (await kinds(page)).length;
    const transitionsBefore = await viewTransitions(page);
    await step();
    await expect.poll(async () => (await kinds(page)).length).toBe(before + 1);
    await settle(page);
    expect((await kinds(page))[before]).toBe(types);
    expect(
      (await viewTransitionTypes(page))
        .slice(transitionsBefore)
        .map((each) => each.join(",")),
    ).toEqual([types]);
  };

  for (const variant of ["log", "log-vt"] as const) {
    test(`${variant}: push, replace, a search change and an action carry their kind`, async ({
      page,
    }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const base = `/vt-kinds/${variant}`;
      await open(page, `${base}/a`);

      await expectStep(
        page,
        () =>
          commit(
            page,
            () => testId(page, "vt-kinds-push").click(),
            `${base}/b`,
          ),
        "push,navigation",
      );
      await expectStep(
        page,
        () =>
          commit(
            page,
            () => testId(page, "vt-kinds-replace").click(),
            `${base}/c`,
          ),
        "replace,navigation",
      );
      await expectStep(
        page,
        () =>
          commit(
            page,
            () => testId(page, "vt-kinds-search").click(),
            `${base}/c?q=1`,
          ),
        "push,navigation",
      );
      await expectStep(page, () => runAction(page, 1), "action");
      expect(pageErrors).toEqual([]);
    });
  }

  test("the same-structure content hold: a search change carries push alone, an action carries action", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await open(page, "/vt-kinds/hold/c");

    await expectStep(
      page,
      () =>
        commit(
          page,
          () => testId(page, "vt-kinds-search").click(),
          "/vt-kinds/hold/c?q=1",
        ),
      "push",
    );
    await expectStep(page, () => runAction(page, 1), "action");
    expect(pageErrors).toEqual([]);
  });

  test("a stale revalidation after Back carries revalidate", async ({
    page,
  }) => {
    // No transition(): the Back restore commits urgently, so only the
    // background revalidation runs in a transition.
    await open(page, "/vt-kinds/hold/a");
    await commit(
      page,
      () => testId(page, "vt-kinds-push").click(),
      "/vt-kinds/hold/b",
    );
    // The action marks the history cache stale: Back restores /a and
    // revalidates it in the background.
    await runAction(page, 1);
    await settle(page);

    await expectStep(
      page,
      async () => {
        await page.goBack();
        await expect(testId(page, "vt-kinds-path")).toHaveText(
          "/vt-kinds/hold/a",
        );
      },
      "revalidate",
    );
  });

  for (const [variant, label] of [
    [
      "push",
      "an app <ViewTransition> under transition({ viewTransition: false })",
    ],
    [
      "push-vt",
      "an app <ViewTransition> under transition() with the router's <ViewTransition>",
    ],
    ["route-push", "the router's <ViewTransition> (transition() class map)"],
  ] as const) {
    test(`a class map keyed by push animates a push, never the action revalidation: ${label}`, async ({
      page,
    }) => {
      await open(page, `/vt-kinds/${variant}/a`);
      const probed = variant !== "route-push";

      await runAction(page, 1);
      await settle(page);
      if (probed) {
        expect(await kinds(page), "the probe resolves none on action").toEqual(
          [],
        );
      }
      // Without the router's own boundary, nothing animates the action.
      if (variant !== "push-vt") {
        expect(await viewTransitions(page)).toBe(0);
      }
      const before = await viewTransitions(page);

      await commit(
        page,
        () => testId(page, "vt-kinds-push").click(),
        `/vt-kinds/${variant}/b`,
      );
      await settle(page);
      if (probed) expect(await kinds(page)).toEqual(["push,navigation"]);
      expect((await viewTransitionTypes(page)).slice(before)).toEqual([
        ["push", "navigation"],
      ]);
    });
  }

  test("a map that keys none of the kinds animates nothing it did not animate before: the content hold and the action start no view transition", async ({
    page,
  }) => {
    await open(page, "/vt-kinds/legacy/c");

    await commit(
      page,
      () => testId(page, "vt-kinds-search").click(),
      "/vt-kinds/legacy/c?q=1",
    );
    await runAction(page, 1);
    await settle(page);
    expect(await viewTransitions(page)).toBe(0);
    expect(await kinds(page)).toEqual([]);
  });
}
