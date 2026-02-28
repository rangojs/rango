import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Tests that ctx.env and ctx.var are consistent across all context types:
 * - HandlerContext (route handler)
 * - MiddlewareContext (route middleware)
 * - LoaderContext (createLoader)
 * - RequestContext (getRequestContext())
 * - ResponseHandlerContext (path.json handler)
 *
 * After the env/vars API simplification, all context types should see:
 * - ctx.env as the same object (bindings directly, not wrapped in RouterEnv)
 * - ctx.var / ctx.get() with variables set by middleware
 */
test.describe("ctx.env and ctx.var consistency", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("RSC route: all context types see consistent env and var values", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/ctx-env-var"));
    await waitForHydration(page);

    await expect(testId(page, "ctx-env-var-page")).toBeVisible();

    // Handler context: env is an object, not undefined
    await expect(testId(page, "handler-env-type")).toHaveText("object");
    await expect(testId(page, "handler-env-str")).toHaveText("{}");
    await expect(testId(page, "handler-var")).toHaveText("from-middleware");

    // Middleware context: env is an object
    await expect(testId(page, "middleware-env-type")).toHaveText("object");
    await expect(testId(page, "middleware-env-keys")).toHaveText("[]");

    // Loader context: env matches handler's env
    await expect(testId(page, "loader-env-type")).toHaveText("object");
    await expect(testId(page, "loader-env-str")).toHaveText("{}");
    await expect(testId(page, "loader-var")).toHaveText("from-middleware");

    // getRequestContext(): env matches handler's env
    await expect(testId(page, "reqctx-env-type")).toHaveText("object");
    await expect(testId(page, "reqctx-env-str")).toHaveText("{}");
    await expect(testId(page, "reqctx-var")).toHaveText("from-middleware");
  });

  test("JSON response route: handler and middleware see consistent env and var", async ({
    request,
  }) => {
    const res = await request.get(f.url("/ctx-env-var/json"));
    expect(res.status()).toBe(200);

    const body = await res.json();

    // Response handler context: env is an object
    expect(body.data.handlerEnvType).toBe("object");
    expect(body.data.handlerEnvStr).toBe("{}");
    expect(body.data.handlerVar).toBe("from-middleware");

    // Middleware captured values
    expect(body.data.mwEnvType).toBe("object");
    expect(body.data.mwEnvKeys).toBe("[]");

    // getRequestContext() from response handler
    expect(body.data.reqCtxEnvType).toBe("object");
    expect(body.data.reqCtxEnvStr).toBe("{}");
    expect(body.data.reqCtxVar).toBe("from-middleware");
  });
});

test.describe("ctx.env and ctx.var consistency (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("RSC route: all context types see consistent env and var values", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/ctx-env-var"));
    await waitForHydration(page);

    await expect(testId(page, "ctx-env-var-page")).toBeVisible();

    // Handler context: env is an object, not undefined
    await expect(testId(page, "handler-env-type")).toHaveText("object");
    await expect(testId(page, "handler-env-str")).toHaveText("{}");
    await expect(testId(page, "handler-var")).toHaveText("from-middleware");

    // Middleware context: env is an object
    await expect(testId(page, "middleware-env-type")).toHaveText("object");
    await expect(testId(page, "middleware-env-keys")).toHaveText("[]");

    // Loader context: env matches handler's env
    await expect(testId(page, "loader-env-type")).toHaveText("object");
    await expect(testId(page, "loader-env-str")).toHaveText("{}");
    await expect(testId(page, "loader-var")).toHaveText("from-middleware");

    // getRequestContext(): env matches handler's env
    await expect(testId(page, "reqctx-env-type")).toHaveText("object");
    await expect(testId(page, "reqctx-env-str")).toHaveText("{}");
    await expect(testId(page, "reqctx-var")).toHaveText("from-middleware");
  });

  test("JSON response route: handler and middleware see consistent env and var", async ({
    request,
  }) => {
    const res = await request.get(f.url("/ctx-env-var/json"));
    expect(res.status()).toBe(200);

    const body = await res.json();

    // Response handler context: env is an object
    expect(body.data.handlerEnvType).toBe("object");
    expect(body.data.handlerEnvStr).toBe("{}");
    expect(body.data.handlerVar).toBe("from-middleware");

    // Middleware captured values
    expect(body.data.mwEnvType).toBe("object");
    expect(body.data.mwEnvKeys).toBe("[]");

    // getRequestContext() from response handler
    expect(body.data.reqCtxEnvType).toBe("object");
    expect(body.data.reqCtxEnvStr).toBe("{}");
    expect(body.data.reqCtxVar).toBe("from-middleware");
  });
});
