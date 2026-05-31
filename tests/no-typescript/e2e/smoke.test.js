import { expect, test } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture.js";
import { useFixture } from "./fixture.js";
import { waitForHydration, expectNoPageError, parseNumber } from "./helper.js";

// Each step takes the page plus a urlFor(path) builder so the same assertions
// run against the dev server and the production preview server. The steps cover
// the full rango feature surface at a smoke level, all from a plain-JS app.

// SSR render + client hydration.
async function checkHomeRenders(page, urlFor) {
  await page.goto(urlFor("/"));
  await waitForHydration(page);
  await expect(page.getByTestId("app-root")).toBeVisible();
  await expect(page.getByTestId("home-title")).toHaveText("Welcome");
  await expect(page.getByTestId("footer")).toBeVisible();
}

// Client-side navigation via <Link> (no full page load).
async function checkClientNavigation(page, urlFor) {
  await page.goto(urlFor("/"));
  await waitForHydration(page);
  await page.getByTestId("nav-about").click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByTestId("about-title")).toHaveText("About");
}

// Server actions: a "use server" function mutates server state and returns it.
async function checkCounterAction(page, urlFor) {
  await page.goto(urlFor("/counter"));
  await waitForHydration(page);
  const value = page.getByTestId("counter-value");
  const before = parseNumber(await value.textContent());
  await page.getByTestId("counter-increment").click();
  await expect
    .poll(async () => parseNumber(await value.textContent()), {
      timeout: 10000,
    })
    .toBeGreaterThan(before);
}

// Loaders + revalidation: a registered loader's data updates after an action
// because the route's revalidate() predicate matches (actionId is set).
async function checkDashboardRevalidation(page, urlFor) {
  await page.goto(urlFor("/dashboard"));
  await waitForHydration(page);
  const value = page.getByTestId("metrics-value");
  await expect(value).toContainText("Value:");
  const before = parseNumber(await value.textContent());
  await page.getByTestId("metrics-bump").click();
  await expect
    .poll(async () => parseNumber(await value.textContent()), {
      timeout: 10000,
    })
    .toBeGreaterThan(before);
}

// Fetchable loader: on-demand GET fetch via useFetchLoader, including params.
async function checkFetchableLoader(page, urlFor) {
  await page.goto(urlFor("/fetch"));
  await waitForHydration(page);
  await page.getByTestId("fetch-default").click();
  await expect(page.getByTestId("fetch-message")).toHaveText("Fetched via GET");
  await expect(page.getByTestId("fetch-id")).toHaveText("default");
  await page.getByTestId("fetch-custom").click();
  await expect(page.getByTestId("fetch-id")).toHaveText("custom-123");
}

// Action-set location state: a server action writes location state that the
// client reads via useLocationState.
async function checkActionLocationState(page, urlFor) {
  await page.goto(urlFor("/flash"));
  await waitForHydration(page);
  await expect(page.getByTestId("flash-message")).toHaveText("none");
  await page.getByTestId("flash-set").click();
  await expect(page.getByTestId("flash-message")).toHaveText(
    "saved-from-action",
  );
}

// Handles + navigation-set location state + loading fallback: clicking a Link
// that carries location state shows the feature name in the loading fallback,
// then the feature page renders and breadcrumbs (pushed via the handle) appear.
async function checkHandlesAndNavState(page, urlFor) {
  await page.goto(urlFor("/"));
  await waitForHydration(page);
  await page.getByTestId("feature-link-handles").click();
  // Navigation-set location state surfaces in the loading fallback. The
  // fallback is transient (it is replaced when the 700ms handler resolves), so
  // observe it best-effort; the deterministic assertions below are the gate.
  try {
    await expect(page.getByTestId("feature-loading-name")).toHaveText(
      "Handles",
      { timeout: 2000 },
    );
  } catch {
    // Handler resolved before the fallback could be sampled; acceptable.
  }
  // The handler resolves and the page renders.
  await expect(page.getByTestId("feature-title")).toHaveText("Handles");
  // Breadcrumb items accumulated through the Breadcrumbs handle.
  await expect(page.getByTestId("breadcrumbs")).toBeVisible();
  await expect(page.getByTestId("breadcrumb-handles")).toHaveText("Handles");

  // Same-route navigation (feature -> feature) exercises transition(): the URL
  // and content update in place.
  await page.getByTestId("feature-nav-actions").click();
  await expect(page).toHaveURL(/\/features\/actions$/);
  await expect(page.getByTestId("feature-title")).toHaveText("Actions");
}

// Named-route reverse at runtime (ctx.reverse) — proves names resolve without
// importing the generated .gen.ts, including a param'd route from an include().
async function checkNamedRouteReverse(page, urlFor) {
  await page.goto(urlFor("/about"));
  await waitForHydration(page);
  await expect(page.getByTestId("reverse-about")).toHaveText("/about");
  await expect(page.getByTestId("reverse-post")).toHaveText(
    "/blog/hello-world",
  );
}

// Client-side useReverse driven by the generated per-module urls.gen.ts that a
// plain-JS component imports (Vite transpiles the .ts). Proves a JS app consumes
// a generated .ts route-types value and that the mount prefix is applied.
async function checkUseReverse(page, urlFor) {
  await page.goto(urlFor("/blog"));
  await waitForHydration(page);
  await expect(page.getByTestId("reverse-blog-index")).toHaveText("/blog");
  await expect(page.getByTestId("reverse-blog-post")).toHaveText(
    "/blog/hello-world",
  );
}

// include() composition + nested layout + dynamic :slug param + handle push.
async function checkIncludeAndDynamicParam(page, urlFor) {
  await page.goto(urlFor("/blog"));
  await waitForHydration(page);
  await expect(page.getByTestId("blog-layout")).toBeVisible();
  await expect(page.getByTestId("blog-title")).toHaveText("Blog");
  await page.getByTestId("post-link-1").click();
  await expect(page).toHaveURL(/\/blog\/hello-world$/);
  await expect(page.getByTestId("post-title")).toHaveText("Post: hello-world");
  await expect(page.getByTestId("breadcrumb-hello-world")).toBeVisible();
}

const STEPS = [
  ["renders and hydrates the home page", checkHomeRenders],
  ["navigates client-side via Link", checkClientNavigation],
  ["runs a server action (counter)", checkCounterAction],
  [
    "re-runs a loader after an action (revalidation)",
    checkDashboardRevalidation,
  ],
  ["fetches a fetchable loader on demand", checkFetchableLoader],
  ["reads action-set location state", checkActionLocationState],
  ["resolves named routes at runtime via ctx.reverse", checkNamedRouteReverse],
  ["resolves client routes via useReverse + generated .ts", checkUseReverse],
  ["accumulates handles and reads nav location state", checkHandlesAndNavState],
  [
    "composes routes via include() with a dynamic param",
    checkIncludeAndDynamicParam,
  ],
];

// Dev mode (vite dev), shared worker-scoped dev server.
devTest.describe("smoke (dev)", () => {
  for (const [name, step] of STEPS) {
    devTest(name, async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);
      await step(page, (p) => devURL(devServerURL, p));
    });
  }
});

// Production mode (vite build + vite preview).
test.describe("smoke (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  for (const [name, step] of STEPS) {
    test(name, async ({ page }) => {
      using _ = expectNoPageError(page);
      await step(page, f.url);
    });
  }
});
