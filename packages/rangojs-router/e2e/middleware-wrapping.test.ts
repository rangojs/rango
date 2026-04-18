import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Tests that middleware(fn, () => [...]) wrapping mode scopes middleware
 * to its children only. A sibling route outside the wrapper must not
 * see the middleware-set context variables or response headers.
 *
 * Covers:
 *   - Single-fn wrapping: middleware(fn, () => [...])
 *   - Array-fn wrapping: middleware([fn1, fn2], () => [...])
 *   - Scoping proof: sibling route outside the wrapper sees "none"
 *   - Response headers set by wrapping middleware
 */
test.describe("middleware wrapping (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("single-fn wrap: child route sees middleware-set variable", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const responsePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes("/middleware-wrapping/single") &&
        resp.status() === 200,
    );

    await page.goto(f.url("/middleware-wrapping/single"));
    const response = await responsePromise;
    await waitForHydration(page);

    await expect(testId(page, "mw-wrap-single-value")).toHaveText(
      "from-single-wrap",
    );
    expect(response.headers()["x-single-wrap"]).toBe("applied");
  });

  test("array-fn wrap: child route sees middleware-set variable", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const responsePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes("/middleware-wrapping/array") &&
        resp.status() === 200,
    );

    await page.goto(f.url("/middleware-wrapping/array"));
    const response = await responsePromise;
    await waitForHydration(page);

    await expect(testId(page, "mw-wrap-array-value")).toHaveText(
      "from-array-wrap",
    );
    expect(response.headers()["x-array-wrap"]).toBe("applied");
  });

  test("outside route does NOT see wrapping middleware variables", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const responsePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes("/middleware-wrapping/outside") &&
        resp.status() === 200,
    );

    await page.goto(f.url("/middleware-wrapping/outside"));
    const response = await responsePromise;
    await waitForHydration(page);

    await expect(testId(page, "mw-wrap-outside-single")).toHaveText("none");
    await expect(testId(page, "mw-wrap-outside-array")).toHaveText("none");
    expect(response.headers()["x-single-wrap"]).toBeUndefined();
    expect(response.headers()["x-array-wrap"]).toBeUndefined();
  });
});

test.describe("middleware wrapping (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("single-fn wrap: child route sees middleware-set variable", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const responsePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes("/middleware-wrapping/single") &&
        resp.status() === 200,
    );

    await page.goto(f.url("/middleware-wrapping/single"));
    const response = await responsePromise;
    await waitForHydration(page);

    await expect(testId(page, "mw-wrap-single-value")).toHaveText(
      "from-single-wrap",
    );
    expect(response.headers()["x-single-wrap"]).toBe("applied");
  });

  test("array-fn wrap: child route sees middleware-set variable", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const responsePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes("/middleware-wrapping/array") &&
        resp.status() === 200,
    );

    await page.goto(f.url("/middleware-wrapping/array"));
    const response = await responsePromise;
    await waitForHydration(page);

    await expect(testId(page, "mw-wrap-array-value")).toHaveText(
      "from-array-wrap",
    );
    expect(response.headers()["x-array-wrap"]).toBe("applied");
  });

  test("outside route does NOT see wrapping middleware variables", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const responsePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes("/middleware-wrapping/outside") &&
        resp.status() === 200,
    );

    await page.goto(f.url("/middleware-wrapping/outside"));
    const response = await responsePromise;
    await waitForHydration(page);

    await expect(testId(page, "mw-wrap-outside-single")).toHaveText("none");
    await expect(testId(page, "mw-wrap-outside-array")).toHaveText("none");
    expect(response.headers()["x-single-wrap"]).toBeUndefined();
    expect(response.headers()["x-array-wrap"]).toBeUndefined();
  });
});
