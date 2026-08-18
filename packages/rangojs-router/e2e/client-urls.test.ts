import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { useFixture } from "./fixture";
import {
  expectNoPageError,
  expectNoReload,
  getNumericContent,
  testId,
  waitForHydration,
} from "./helper";

const INDEX_PATH = "/client-urls-e2e";
const HARD_LOAD_PATH = "/client-urls-e2e/items/hard-load";
const SOFT_NAV_PATH = "/client-urls-e2e/items/soft-nav";
const ORDINARY_SERVER_PATH = "/factory-hmr/alpha";

/**
 * Flash detection via MutationObserver on addedNodes so even a single-frame
 * skeleton is caught — a plain toBeHidden() would miss it. Same mechanism as
 * e2e/conditional-transition.test.ts.
 */
async function watchFlash(page: Page, fallbackTestId: string): Promise<void> {
  await page.evaluate((id) => {
    const w = window as unknown as {
      __flash?: boolean;
      __obs?: MutationObserver;
    };
    w.__flash = document.querySelector(`[data-testid="${id}"]`) != null;
    const hit = (n: Node) =>
      n.nodeType === 1 &&
      ((n as Element).matches?.(`[data-testid="${id}"]`) ||
        (n as Element).querySelector?.(`[data-testid="${id}"]`) != null);
    w.__obs = new MutationObserver((records) => {
      for (const r of records)
        for (const n of Array.from(r.addedNodes)) if (hit(n)) w.__flash = true;
    });
    w.__obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }, fallbackTestId);
}

async function readFlash(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __flash?: boolean;
      __obs?: MutationObserver;
    };
    w.__obs?.disconnect();
    return w.__flash === true;
  });
}

async function expectItem(
  page: Page,
  itemId: "hard-load" | "soft-nav",
): Promise<void> {
  await expect(testId(page, "client-urls-item")).toBeVisible();
  await expect(testId(page, "client-urls-item-param")).toHaveText(itemId);
  await expect(testId(page, "client-urls-item-loader")).toHaveText(
    `client-urls-item:${itemId}`,
  );
  await expect(testId(page, "client-urls-layout")).toHaveAttribute(
    "data-pending",
    "false",
  );
}

function clientUrlsTests(f: ReturnType<typeof useFixture>): void {
  test("hard load SSRs and hydrates params, loader data, and settled outlet state", async ({
    page,
    request,
  }) => {
    using _ = expectNoPageError(page);

    const response = await request.get(f.url(HARD_LOAD_PATH), {
      headers: { accept: "text/html" },
    });
    const html = await response.text();
    expect(response.ok()).toBe(true);
    expect(html).toContain('data-testid="client-urls-layout"');
    expect(html).toContain('data-pending="false"');
    expect(html).toContain('data-testid="client-urls-item-param"');
    expect(html).toContain("hard-load");
    expect(html).toContain("client-urls-item:hard-load");

    const ordinaryResponse = await request.get(f.url(ORDINARY_SERVER_PATH), {
      headers: { accept: "text/html" },
    });
    const ordinaryHtml = await ordinaryResponse.text();
    expect(ordinaryResponse.ok()).toBe(true);
    expect(ordinaryHtml).toContain('data-testid="factory-alpha"');

    await page.goto(f.url(HARD_LOAD_PATH));
    await waitForHydration(page);
    await expectItem(page, "hard-load");
  });

  test("async include() mounts a clientUrls group when every segment is named", async ({
    page,
    request,
  }) => {
    // Nested lazy includes require explicit names (unnamed auto-names diverge
    // between discovery and runtime expansion — see client-urls-async-named.ts).
    // With names, the async-include mount composes and serves end to end.
    const response = await request.get(
      f.url("/client-urls-async/nested/items/beta"),
      { headers: { accept: "text/html" } },
    );
    expect(response.ok()).toBe(true);
    const html = await response.text();
    expect(html).toContain('data-testid="ci-item"');
    expect(html).toContain("client-urls-item:beta");

    using _ = expectNoPageError(page);
    await page.goto(f.url("/client-urls-async/nested"));
    await waitForHydration(page);
    await expect(testId(page, "ci-index")).toBeVisible();
  });

  test("intercept targets a client route from a server-page origin", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Server-page origin: no client group is mounted, so there is no local
    // presentation to coordinate — the canonical response commits the modal
    // over the origin page like any server-target intercept.
    await page.goto(f.url("/client-urls-intercept-origin"));
    await waitForHydration(page);
    await expect(testId(page, "ci-origin")).toBeVisible();

    {
      await using __ = await expectNoReload(page);
      await testId(page, "ci-origin-link").click();
      await expect(testId(page, "ci-modal")).toBeVisible();
      await expect(testId(page, "ci-modal-item")).toHaveText(
        "client-urls-item:alpha",
      );
      // The origin page stays rendered underneath; the full item view did not.
      await expect(testId(page, "ci-origin")).toBeVisible();
      await expect(testId(page, "ci-item")).not.toBeVisible();
      await expect(page).toHaveURL(f.url("/client-urls-intercept/items/alpha"));
    }

    // Hard load of the same URL renders the full client route, not the modal.
    await page.goto(f.url("/client-urls-intercept/items/alpha"));
    await waitForHydration(page);
    await expect(testId(page, "ci-item-param")).toHaveText("alpha");
    await expect(testId(page, "ci-item-loader")).toHaveText(
      "client-urls-item:alpha",
    );
  });

  test("intercept claims a client target from a same-group origin without local presentation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Same-group origin: the local matcher KNOWS the target, but the current
    // location's metadata lists it as intercept-claimed — the optimistic
    // presentation declines, the origin stays untouched, and the canonical
    // response commits the modal over it (no loading flash-and-revert).
    await page.goto(f.url("/client-urls-intercept"));
    await waitForHydration(page);
    await expect(testId(page, "ci-index")).toBeVisible();

    await using __ = await expectNoReload(page);
    let releaseRequest!: () => void;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    await page.route("**/client-urls-intercept/items/alpha*", async (route) => {
      await requestGate;
      await route.continue();
    });
    await testId(page, "ci-item-link").click();
    try {
      // Hold the gate open long enough that a wrongly-fired presentation
      // would be visible, then assert its absence.
      await page.waitForTimeout(250);
      await expect(testId(page, "ci-item-loading")).not.toBeVisible();
      await expect(testId(page, "ci-layout")).toHaveAttribute(
        "data-pending",
        "false",
      );
      await expect(testId(page, "ci-index")).toBeVisible();
    } finally {
      releaseRequest();
    }

    await expect(testId(page, "ci-modal")).toBeVisible();
    await expect(testId(page, "ci-modal-item")).toHaveText(
      "client-urls-item:alpha",
    );
    await expect(testId(page, "ci-index")).toBeVisible();
    await expect(page).toHaveURL(f.url("/client-urls-intercept/items/alpha"));
  });

  test("client-declared intercept is module-local: modal in-group, full route from outside", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // In-group origin: the module's own intercept("@modal", ".detail") claims
    // the navigation — the index stays rendered with the modal over it.
    await page.goto(f.url("/client-urls-intercept"));
    await waitForHydration(page);
    await expect(testId(page, "ci-index")).toBeVisible();

    {
      await using __ = await expectNoReload(page);
      await testId(page, "ci-detail-link").click();
      await expect(testId(page, "ci-client-modal")).toBeVisible();
      await expect(testId(page, "ci-client-modal-item")).toHaveText(
        "client-urls-item:gamma",
      );
      await expect(testId(page, "ci-index")).toBeVisible();
      await expect(testId(page, "ci-detail")).not.toBeVisible();
      await expect(page).toHaveURL(
        f.url("/client-urls-intercept/detail/gamma"),
      );
    }

    // Outside origin: the intercept's owning layout entry is not in the origin
    // chain, so the SAME navigation commits the full detail route — no modal.
    await page.goto(f.url("/client-urls-intercept-origin"));
    await waitForHydration(page);
    await expect(testId(page, "ci-origin")).toBeVisible();

    {
      await using __ = await expectNoReload(page);
      await testId(page, "ci-origin-detail-link").click();
      await expect(testId(page, "ci-detail")).toBeVisible();
      await expect(testId(page, "ci-detail-param")).toHaveText("gamma");
      await expect(testId(page, "ci-detail-loader")).toHaveText(
        "client-urls-item:gamma",
      );
      await expect(testId(page, "ci-client-modal")).not.toBeVisible();
      await expect(page).toHaveURL(
        f.url("/client-urls-intercept/detail/gamma"),
      );
    }

    // Hard load renders the full detail route, never the modal.
    await page.goto(f.url("/client-urls-intercept/detail/gamma"));
    await waitForHydration(page);
    await expect(testId(page, "ci-detail-param")).toHaveText("gamma");
    await expect(testId(page, "ci-client-modal")).not.toBeVisible();
  });

  test("action revalidates the clientUrls group's loaders; parent RSC layout keeps the locked skip", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // The group's loaders are its server-side revalidation surface: declared
    // on the client LAYOUT, flattened into the route record, re-run on the
    // action follow-up (route-owned segments default true on actions). The
    // parent-chain RSC layout reads the SAME counter and declares no
    // revalidate(), so the locked `action:parent-chain-skip` default keeps
    // its pre-action value in the same commit.
    await page.goto(f.url("/client-urls-action"));
    await waitForHydration(page);
    const initial = await testId(page, "ca-loader").textContent();
    const count = Number(initial?.replace("count:", ""));
    expect(Number.isNaN(count)).toBe(false);
    await expect(testId(page, "ca-session")).toHaveText(`session:${count}`);
    await expect(testId(page, "ca-parent-count")).toHaveText(`parent:${count}`);

    await using __ = await expectNoReload(page);
    await testId(page, "ca-bump").click();
    await expect(testId(page, "ca-loader")).toHaveText(`count:${count + 1}`);
    // Per-loader CLIENT-RUN revalidate(): the session loader's predicate
    // opted out of action revalidation — same route, same commit, held data.
    await expect(testId(page, "ca-session")).toHaveText(`session:${count}`);
    await expect(testId(page, "ca-parent-count")).toHaveText(`parent:${count}`);
  });

  test("client revalidate() isAction() matches a target action and a namespace import", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Client-run isAction() is the same matcher as the server predicate:
    // isAction(target) re-runs only the target-gated loader; isAction(* as
    // Actions) re-runs on any export of that module (target + decoy). The
    // bump action lives in a different module and matches neither.
    await page.goto(f.url("/client-urls-action"));
    await waitForHydration(page);
    await using __ = await expectNoReload(page);

    const readTarget = (): Promise<number> =>
      getNumericContent(testId(page, "ca-is-action-target-runs"));
    const readNs = (): Promise<number> =>
      getNumericContent(testId(page, "ca-is-action-ns-runs"));

    const initialTarget = await readTarget();
    const initialNs = await readNs();

    await testId(page, "ca-is-action-target").click();
    await expect.poll(readTarget).toBeGreaterThan(initialTarget);
    await expect.poll(readNs).toBeGreaterThan(initialNs);
    const afterTarget = await readTarget();
    const afterTargetNs = await readNs();

    await testId(page, "ca-is-action-decoy").click();
    await expect.poll(readNs).toBeGreaterThan(afterTargetNs);
    await expect(testId(page, "ca-is-action-target-runs")).toHaveText(
      String(afterTarget),
    );
  });

  test("client revalidate() decisions transport on same-route param navs, not only actions", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // The session loader never revalidates (revalidate(() => false)); the
    // counter loader follows defaults. The action bump makes them diverge,
    // and the param nav is the probe: its GET re-evaluates the held route's
    // loaders (params changed -> default true), so WITHOUT the decision
    // header the session value would catch up to the counter. Holding proves
    // the skip rode the navigation request.
    await page.goto(f.url("/client-urls-action/items/alpha"));
    await waitForHydration(page);
    const initial = await testId(page, "ca-item-count").textContent();
    const count = Number(initial?.replace("count:", ""));
    expect(Number.isNaN(count)).toBe(false);
    await expect(testId(page, "ca-item-session")).toHaveText(
      `session:${count}`,
    );

    await using __ = await expectNoReload(page);

    // Action: counter refreshes, session decision (skip) rides the POST.
    await testId(page, "ca-item-bump").click();
    await expect(testId(page, "ca-item-count")).toHaveText(
      `count:${count + 1}`,
    );
    await expect(testId(page, "ca-item-session")).toHaveText(
      `session:${count}`,
    );

    // Same-route param nav: the skip rides the partial GET.
    await testId(page, "ca-item-to-beta").click();
    await expect(testId(page, "ca-item-param")).toHaveText("beta");
    await expect(testId(page, "ca-item-loader")).toHaveText(
      "client-urls-item:beta",
    );
    await expect(testId(page, "ca-item-count")).toHaveText(
      `count:${count + 1}`,
    );
    await expect(testId(page, "ca-item-session")).toHaveText(
      `session:${count}`,
    );
  });

  test("client-declared transition() holds same-route param navs; the plain twin re-streams", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // transition({...}) on the client route: the same-route param nav
    // re-suspends the existing boundary, and the transition holds previous
    // content — the loading() skeleton must never appear.
    await page.goto(f.url("/client-urls-transition/items/one"));
    await waitForHydration(page);
    await expect(testId(page, "ct-item-loader")).toHaveText(
      "client-urls-item:one",
    );

    {
      await using __ = await expectNoReload(page);
      await watchFlash(page, "ct-item-loading");
      await testId(page, "ct-item-to-two").click();
      await expect(testId(page, "ct-item-loader")).toHaveText(
        "client-urls-item:two",
      );
      expect(
        await readFlash(page),
        "transition() must hold the same-route nav (no skeleton flash)",
      ).toBe(false);
    }

    // Control: the twin route WITHOUT transition() re-streams its skeleton on
    // the same navigation shape, proving the observable discriminates.
    await page.goto(f.url("/client-urls-transition/plain/one"));
    await waitForHydration(page);
    await expect(testId(page, "ct-plain-loader")).toHaveText(
      "client-urls-item:one",
    );

    {
      await using __ = await expectNoReload(page);
      await watchFlash(page, "ct-plain-loading");
      await testId(page, "ct-plain-to-two").click();
      await expect(testId(page, "ct-plain-loader")).toHaveText(
        "client-urls-item:two",
      );
      expect(
        await readFlash(page),
        "the transition-less twin must re-stream the loading() skeleton",
      ).toBe(true);
    }
  });

  test("soft navigation shows local loading and pending state before committing, then Back restores index", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url(INDEX_PATH));
    await waitForHydration(page);
    await expect(testId(page, "client-urls-index")).toBeVisible();
    await expect(testId(page, "client-urls-layout")).toHaveAttribute(
      "data-pending",
      "false",
    );

    await using __ = await expectNoReload(page);
    let releaseRequest!: () => void;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    await page.route(`**${SOFT_NAV_PATH}*`, async (route) => {
      await requestGate;
      await route.continue();
    });
    await testId(page, "client-urls-item-link").click();

    try {
      await Promise.all([
        expect(testId(page, "client-urls-item-loading")).toBeVisible({
          timeout: 500,
        }),
        expect(testId(page, "client-urls-layout")).toHaveAttribute(
          "data-pending",
          "true",
          { timeout: 500 },
        ),
      ]);
    } finally {
      releaseRequest();
    }

    await expectItem(page, "soft-nav");
    await expect(page).toHaveURL(f.url(SOFT_NAV_PATH));

    await page.goBack();
    await expect(page).toHaveURL(f.url(INDEX_PATH));
    await expect(testId(page, "client-urls-index")).toBeVisible();
    await expect(testId(page, "client-urls-layout")).toHaveAttribute(
      "data-pending",
      "false",
    );
  });

  test("hook probe: mount, absolute pathname, SSR search values, setter write", async ({
    page,
    request,
  }) => {
    using _ = expectNoPageError(page);

    // SSR pin: the live request's search seeds the SSR store
    // (SSRRenderOptions.search → createSsrEventController), so the SSR'd
    // HTML carries the REAL search-derived branch — no post-hydration flip.
    const response = await request.get(
      f.url("/client-urls-e2e/hooks?flavor=mint"),
      { headers: { accept: "text/html" } },
    );
    expect(response.ok()).toBe(true);
    expect(await response.text()).toContain("flavor:mint");

    // Hydration agrees (waitForHydration fails the test on any hydration
    // error): browser first render seeds from window.location — same URL.
    await page.goto(f.url("/client-urls-e2e/hooks?flavor=mint"));
    await waitForHydration(page);
    await expect(testId(page, "cu-hooks-flavor")).toHaveText("flavor:mint");

    // useMount is the include mount; usePathname is ABSOLUTE (mount
    // included) — group code must not treat it as definition-local.
    await expect(testId(page, "cu-hooks-mount")).toHaveText(
      "mount:/client-urls-e2e",
    );
    await expect(testId(page, "cu-hooks-pathname")).toHaveText(
      "pathname:/client-urls-e2e/hooks",
    );

    // Setter: a same-route write inside the group (wholesale replace).
    await using __ = await expectNoReload(page);
    await testId(page, "cu-hooks-set-flavor").click();
    await expect(testId(page, "cu-hooks-flavor")).toHaveText("flavor:mint");
    await expect(page).toHaveURL(f.url("/client-urls-e2e/hooks?flavor=mint"));
  });

  test("hook probe: useHref composes the include mount", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/client-urls-e2e/hooks"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);
    await testId(page, "cu-hooks-href-link").click();

    // groupHref("/items/href-nav") resolved under the include mount.
    await expect(testId(page, "client-urls-item-param")).toHaveText("href-nav");
    await expect(page).toHaveURL(f.url("/client-urls-e2e/items/href-nav"));
  });

  test("hook probe: useLinkStatus and useNavigation report a group nav", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/client-urls-e2e/hooks"));
    await waitForHydration(page);
    await expect(testId(page, "cu-hooks-link-status")).toHaveText("false");
    await expect(testId(page, "cu-hooks-nav-state")).toHaveText("nav:idle");

    await using __ = await expectNoReload(page);
    let releaseRequest!: () => void;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    // URL-predicate matcher: gate exactly the index partial request. The
    // nav target is groupHref("/") — the TRAILING-SLASH form of the bare
    // mount — so normalize before comparing (an endsWith on the bare path
    // silently never matches and the test only passes by racing the fetch).
    await page.route(
      (url) => url.pathname.replace(/\/$/, "").endsWith("/client-urls-e2e"),
      async (route) => {
        await requestGate;
        await route.continue();
      },
    );
    await testId(page, "cu-hooks-status-link").click();
    try {
      // Both global signals fire for a group-internal nav while the request
      // is held; the probe stays mounted because the index destination has
      // no loading() (no optimistic swap).
      await expect(testId(page, "cu-hooks-link-status")).toHaveText("true", {
        timeout: 2000,
      });
      await expect(testId(page, "cu-hooks-nav-state")).toHaveText(
        "nav:loading",
        { timeout: 2000 },
      );
    } finally {
      releaseRequest();
    }

    await expect(testId(page, "client-urls-index")).toBeVisible();
    // groupHref("/") composes mount + module index and yields the
    // trailing-slash form of the bare mount.
    await expect(page).toHaveURL(f.url(`${INDEX_PATH}/`));
  });

  test("hook probe: useFetchLoader fetches by loader id from inside the group", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/client-urls-e2e/hooks"));
    await waitForHydration(page);
    await expect(testId(page, "cu-hooks-stamp")).toHaveText("stamp:none");

    // The fetch lane is route-independent — no group mechanics involved.
    // revalidate() predicates are deliberately NOT consulted: an imperative
    // load() is an explicit freshness request.
    await testId(page, "cu-hooks-fetch-stamp").click();
    await expect(testId(page, "cu-hooks-stamp")).toHaveText(/stamp:\d+/);
    const first = await testId(page, "cu-hooks-stamp").textContent();

    await testId(page, "cu-hooks-fetch-stamp").click();
    await expect(testId(page, "cu-hooks-stamp")).not.toHaveText(first!);
  });

  test("hook probe: relative router.push resolves against the include mount", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/client-urls-e2e/hooks"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);
    // push("items/rel-nav") — no leading slash — joins the mount.
    await testId(page, "cu-hooks-rel-push").click();

    await expect(testId(page, "client-urls-item-param")).toHaveText("rel-nav");
    await expect(page).toHaveURL(f.url("/client-urls-e2e/items/rel-nav"));
  });

  test("hook probe: useRefreshLoaders re-runs a group-tagged read", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/client-urls-e2e/hooks"));
    await waitForHydration(page);
    await expect(testId(page, "cu-hooks-pulse")).toHaveText(/pulse:\d+/);
    const first = await testId(page, "cu-hooks-pulse").textContent();

    // The refresh GET deliberately bypasses revalidate() decisions — an
    // explicit refresh is an explicit freshness request (same settlement as
    // useFetchLoader).
    await testId(page, "cu-hooks-refresh-pulse").click();
    await expect(testId(page, "cu-hooks-pulse")).not.toHaveText(first!, {
      timeout: 5000,
    });
  });

  test("hook probe: useAction tracks a group action's lifecycle", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/client-urls-e2e/hooks"));
    await waitForHydration(page);
    await expect(testId(page, "cu-hooks-action-state")).toHaveText(
      "action:idle",
    );

    await using __ = await expectNoReload(page);
    let releaseRequest!: () => void;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    // Hold only the action POST; every other request flows.
    await page.route(
      () => true,
      async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        await requestGate;
        return route.continue();
      },
    );
    await testId(page, "cu-hooks-run-action").click();
    try {
      await expect(testId(page, "cu-hooks-action-state")).toHaveText(
        "action:loading",
        { timeout: 2000 },
      );
    } finally {
      releaseRequest();
    }

    await expect(testId(page, "cu-hooks-action-state")).toHaveText(
      "action:idle",
    );
  });

  test("hook probe: useReverse local form composes the include mount", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/client-urls-e2e/hooks"));
    await waitForHydration(page);

    // The module's own client-urls.gen.ts map is the scope; the include
    // mount prefixes results, and the "/" index collapses to the bare mount
    // (no trailing slash) — same contract as ctx.reverse(".index").
    await expect(testId(page, "cu-hooks-reverse")).toHaveText(
      "reverse:/client-urls-e2e/items/rev-1|/client-urls-e2e",
    );
  });

  test("hook probe: a group action writes location state in place", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/client-urls-e2e/state"));
    await waitForHydration(page);
    await expect(testId(page, "cu-state-note")).toHaveText("note:none");

    await using __ = await expectNoReload(page);
    await testId(page, "cu-state-set-note").click();

    // Action lane: merge into the CURRENT history entry when the response
    // settles — no navigation, no remount, same URL.
    await expect(testId(page, "cu-state-note")).toHaveText("note:from-action");
    await expect(page).toHaveURL(f.url("/client-urls-e2e/state"));
  });

  test("hook probe: an action redirect delivers flash state into the group", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/client-urls-e2e/state"));
    await waitForHydration(page);
    await expect(testId(page, "cu-state-flash")).toHaveText("flash:none");

    await using __ = await expectNoReload(page);
    await testId(page, "cu-state-action-redirect").click();

    // redirect(url, { state }) from an action: the redirect nav carries the
    // flash into the target entry (same route, new search).
    await expect(page).toHaveURL(f.url("/client-urls-e2e/state?saved=1"));
    await expect(testId(page, "cu-state-flash")).toHaveText(
      "flash:cu-action-flash",
    );
  });

  test("hook probe: a loader redirect carries its location state to the target", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/client-urls-e2e/state"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);
    await testId(page, "cu-state-legacy-link").click();

    // /legacy's loader awaits a tick, then throws redirect() with flash
    // state. The state settles AFTER payload metadata flushed, so it must
    // travel with the redirect navigation itself and merge at the target.
    await expect(page).toHaveURL(f.url("/client-urls-e2e/state?from=legacy"));
    await expect(testId(page, "cu-state-flash")).toHaveText(
      "flash:cu-loader-flash",
    );
  });

  test("hook probe: a plain React ErrorBoundary is the in-group error affordance", async ({
    page,
  }) => {
    await page.goto(f.url("/client-urls-e2e/hooks"));
    await waitForHydration(page);

    await testId(page, "cu-hooks-boom").click();

    // The boundary catches the render throw; the group chrome around it
    // stays intact (no route-level swap, no navigation).
    await expect(testId(page, "cu-hooks-error-fallback")).toBeVisible();
    await expect(testId(page, "client-urls-layout")).toBeVisible();
    await expect(page).toHaveURL(f.url("/client-urls-e2e/hooks"));
  });
}

test.describe("clientUrls vertical slice", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });

  clientUrlsTests(f);
});

test.describe("clientUrls vertical slice (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });

  clientUrlsTests(f);

  // No chunk waterfall on a group landing: the SSR'd document must carry an
  // EXECUTING module script for the built chunk that holds the group's
  // components (ssr/preinit-client-references.ts upgrades the Flight preinit
  // to a script tag in build), so the fetch starts with the first HTML bytes
  // instead of waiting for hydration's dynamic import. Build-artifact
  // assertion — production-only by nature (dev serves unbundled modules).
  test("group-route document preloads the chunk carrying the group's components", async ({
    request,
  }) => {
    const assetsDir = path.resolve("./e2e/test-app/dist/client/assets");
    const chunk = fs
      .readdirSync(assetsDir)
      .find(
        (name) =>
          name.endsWith(".js") &&
          fs
            .readFileSync(path.join(assetsDir, name), "utf-8")
            .includes("cu-state-flash"),
      );
    expect(
      chunk,
      "no client chunk contains the group probe marker",
    ).toBeTruthy();

    const res = await request.get(f.url("/client-urls-e2e/state"), {
      headers: { Accept: "text/html" },
    });
    const html = await res.text();
    const escaped = chunk!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(html).toMatch(
      new RegExp(`<script[^>]*src="/assets/${escaped}"[^>]*type="module"`),
    );
  });
});
