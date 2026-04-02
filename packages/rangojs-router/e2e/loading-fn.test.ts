import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId } from "./helper";

/**
 * Test that loading() accepts both ReactNode and () => ReactNode.
 * The function form should be unwrapped at registration time and
 * behave identically to the element form.
 *
 * Skeleton presence is verified via raw SSR HTML — Suspense always
 * sends the fallback in the initial chunk before the async handler
 * resolves, so the skeleton markup is reliably in the response.
 */

test.describe("loading function form", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("loading(() => <JSX />) SSR contains skeleton markup", async ({
    request,
  }) => {
    const res = await request.get(f.url("/loading-fn-test"), {
      headers: { accept: "text/html" },
    });
    const html = await res.text();
    expect(html).toContain("loading-fn-skeleton");
  });

  test("loading(() => <JSX />) resolves to final content", async ({ page }) => {
    await page.goto(f.url("/loading-fn-test"));
    await waitForHydration(page);

    await expect(testId(page, "loading-fn-page")).toBeVisible();
    await expect(testId(page, "loading-fn-page")).toHaveText("Loaded content");
  });

  test("loading(() => <ClientComponent />) SSR contains client skeleton", async ({
    request,
  }) => {
    const res = await request.get(f.url("/loading-fn-client-test"), {
      headers: { accept: "text/html" },
    });
    const html = await res.text();
    expect(html).toContain("loading-fn-client-skeleton");
  });

  test("loading(<ClientComponent />) element form SSR contains skeleton", async ({
    request,
  }) => {
    const res = await request.get(f.url("/loading-element-client-test"), {
      headers: { accept: "text/html" },
    });
    const html = await res.text();
    expect(html).toContain("loading-fn-client-skeleton");
  });
});

test.describe("loading function form (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("loading(() => <Skeleton />) works in production", async ({ page }) => {
    await page.goto(f.url("/loading-fn-test"));
    await waitForHydration(page);

    await expect(testId(page, "loading-fn-page")).toBeVisible();
    await expect(testId(page, "loading-fn-page")).toHaveText("Loaded content");
  });

  test("loading(() => <ClientComponent />) works in production", async ({
    page,
  }) => {
    await page.goto(f.url("/loading-fn-client-test"));
    await waitForHydration(page);

    await expect(testId(page, "loading-fn-client-page")).toBeVisible();
    await expect(testId(page, "loading-fn-client-page")).toHaveText(
      "Loaded client content",
    );
  });

  test("loading(<ClientComponent />) element form works in production", async ({
    page,
  }) => {
    await page.goto(f.url("/loading-element-client-test"));
    await waitForHydration(page);

    await expect(testId(page, "loading-element-client-page")).toBeVisible();
    await expect(testId(page, "loading-element-client-page")).toHaveText(
      "Loaded element client content",
    );
  });

  test("loading(() => <ClientComponent />) SSR contains skeleton in production", async ({
    request,
  }) => {
    const res = await request.get(f.url("/loading-fn-client-test"), {
      headers: { accept: "text/html" },
    });
    const html = await res.text();
    expect(html).toContain("loading-fn-client-skeleton");
  });

  test("loading(<ClientComponent />) element form SSR contains skeleton in production", async ({
    request,
  }) => {
    const res = await request.get(f.url("/loading-element-client-test"), {
      headers: { accept: "text/html" },
    });
    const html = await res.text();
    expect(html).toContain("loading-fn-client-skeleton");
  });
});
