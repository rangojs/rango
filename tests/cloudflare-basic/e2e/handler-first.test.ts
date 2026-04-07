import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

test.describe.configure({ mode: "serial" });

// -- Dev mode ----------------------------------------------------------------

test.describe("handler-first execution order (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("route handler ctx.set() is visible to layout via ctx.get()", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/handler-first"));
    await waitForHydration(page);

    await expect(testId(page, "handler-first-title")).toHaveText(
      "Handler First",
    );
    await expect(testId(page, "layout-get-value")).toHaveText(
      "Layout got: from-handler",
    );
  });

  test("route handler ctx.set() is visible to parallel via ctx.get()", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/handler-first"));
    await waitForHydration(page);

    await expect(testId(page, "sidebar-get-value")).toHaveText(
      "Sidebar got: from-handler",
    );
  });
});

// -- Production build --------------------------------------------------------

test.describe("handler-first execution order (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("route handler ctx.set() is visible to layout via ctx.get()", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/handler-first"));
    await waitForHydration(page);

    await expect(testId(page, "handler-first-title")).toHaveText(
      "Handler First",
    );
    await expect(testId(page, "layout-get-value")).toHaveText(
      "Layout got: from-handler",
    );
  });

  test("route handler ctx.set() is visible to parallel via ctx.get()", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/handler-first"));
    await waitForHydration(page);

    await expect(testId(page, "sidebar-get-value")).toHaveText(
      "Sidebar got: from-handler",
    );
  });
});
