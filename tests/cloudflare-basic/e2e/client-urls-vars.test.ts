import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import {
  expectNoPageError,
  expectNoReload,
  testId,
  waitForHydration,
} from "./helper";

const VARS_PATH = "/client-urls-vars";
const VARS_EXPECTED = "var:alice|str:alice-str";

/**
 * workerd mirror of the test-app "middleware vars" cases
 * (packages/rangojs-router/e2e/client-urls.test.ts): route middleware
 * `ctx.set()` of a createVar() token and a string key is visible to a
 * clientUrls() group loader on the document and _rsc_partial lanes, while the
 * _rsc_loader fetch lane runs only the loader's own middleware list.
 */
function runClientUrlsVarsSpec(f: Fixture): void {
  test("a createVar token and a string key reach a group loader on the document and partial lanes", async ({
    page,
    request,
  }) => {
    using _ = expectNoPageError(page);

    const [documentResponse, partialResponse] = await Promise.all([
      request.get(f.url(VARS_PATH), { headers: { accept: "text/html" } }),
      request.get(f.url(`${VARS_PATH}/other?_rsc_partial=true`), {
        headers: { accept: "text/x-component" },
      }),
    ]);
    expect(documentResponse.ok()).toBe(true);
    expect(await documentResponse.text()).toContain(VARS_EXPECTED);
    expect(partialResponse.ok()).toBe(true);
    expect(await partialResponse.text()).toContain(VARS_EXPECTED);

    await page.goto(f.url(VARS_PATH));
    await waitForHydration(page);
    await expect(testId(page, "cu-vars-route")).toHaveText(VARS_EXPECTED);

    await using __ = await expectNoReload(page);
    await testId(page, "cu-vars-other-link").click();
    await expect(testId(page, "cu-vars-other-route")).toHaveText(VARS_EXPECTED);
    await testId(page, "cu-vars-index-link").click();
    await expect(testId(page, "cu-vars-route")).toHaveText(VARS_EXPECTED);
  });

  test("the fetch lane skips route middleware unless the loader carries it", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url(VARS_PATH));
    await waitForHydration(page);

    await testId(page, "cu-vars-fetch-bare-btn").click();
    await expect(testId(page, "cu-vars-fetch-bare")).toHaveText(
      "var:undefined|str:undefined",
    );

    await testId(page, "cu-vars-fetch-mw-btn").click();
    await expect(testId(page, "cu-vars-fetch-mw")).toHaveText(VARS_EXPECTED);
  });
}

test.describe("clientUrls middleware vars", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runClientUrlsVarsSpec(f);
});

test.describe("clientUrls middleware vars (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runClientUrlsVarsSpec(f);
});
