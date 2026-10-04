/**
 * E2E: Origin guard (CSRF protection).
 *
 * Verifies that cross-origin requests to server actions, loader fetches,
 * and PE form submissions are rejected with 403, and that a rejected request
 * to a REAL action does not run it (the guard fires before execution).
 * Same-origin requests and regular page navigations are unaffected.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

// ---------------------------------------------------------------------------
// Helper: build a cross-origin request with a spoofed Origin header
// ---------------------------------------------------------------------------
function crossOriginHeaders(accept = "text/x-component") {
  return {
    Accept: accept,
    Origin: "https://evil.com",
  };
}

// ---------------------------------------------------------------------------
// Real-action cases: /progressive-enhancement renders a <form> bound to
// submitNameAction, which stores the submitted name and renders it back
// (pe-result-name). A probe value that never appears proves the action did
// not run; the same-origin control proves the same submission would have.
// ---------------------------------------------------------------------------
async function peFormActionId(
  request: APIRequestContext,
  url: string,
): Promise<string> {
  // React renders the bound action's id as a hidden field; it is hashed in
  // production builds, so read it from the page instead of hard-coding it.
  const html = await (await request.get(url)).text();
  const match = html.match(/name="\$ACTION_ID_([^"]+)"/);
  expect(match, "PE form's hidden $ACTION_ID_ field").not.toBeNull();
  return match![1]!;
}

function uniqueProbe(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// No-JS form encodings: urlencoded is a hand-written cross-site <form>'s
// default; multipart is what React renders for a server-action <form>. The
// multipart case needs Playwright >= 1.62: earlier versions drop the empty
// `$ACTION_ID_` field, so the same-origin control would not run the action
// (#885).
const PE_FORM_ENCODINGS = ["urlencoded", "multipart"] as const;

function peFormBody(
  encoding: (typeof PE_FORM_ENCODINGS)[number],
  fields: Record<string, string>,
): { form: Record<string, string> } | { multipart: Record<string, string> } {
  return encoding === "multipart" ? { multipart: fields } : { form: fields };
}

function realActionCases(f: Fixture) {
  for (const encoding of PE_FORM_ENCODINGS) {
    test(`a cross-origin ${encoding} form post to a real action is rejected and the action does not run`, async ({
      request,
    }) => {
      const pageUrl = f.url("/progressive-enhancement");
      const actionId = await peFormActionId(request, pageUrl);

      // Control: the same submission from the same origin runs the action;
      // the PE response re-renders the page with the submitted name. Without
      // it, the cross-site assertions below pass even if the body never
      // reached the action.
      const control = uniqueProbe("same-origin");
      const allowed = await request.post(pageUrl, {
        headers: { Accept: "text/html" },
        ...peFormBody(encoding, {
          [`$ACTION_ID_${actionId}`]: "",
          name: control,
        }),
      });
      expect(allowed.status()).toBe(200);
      expect(await allowed.text()).toContain(control);

      const probe = uniqueProbe("cross-site");
      const rejected = await request.post(pageUrl, {
        headers: { Accept: "text/html", Origin: "https://evil.com" },
        ...peFormBody(encoding, {
          [`$ACTION_ID_${actionId}`]: "",
          name: probe,
        }),
      });
      expect(rejected.status()).toBe(403);
      expect(rejected.headers()["x-rango-origin-check"]).toBe("failed");

      const after = await (await request.get(pageUrl)).text();
      expect(after).not.toContain(probe);
    });
  }

  test("a cross-origin RSC call to a real action is rejected and the action does not run", async ({
    request,
  }) => {
    const pageUrl = f.url("/progressive-enhancement");
    const actionId = await peFormActionId(request, pageUrl);

    const probe = uniqueProbe("cross-site-rsc");
    const rejected = await request.post(
      f.url(
        `/progressive-enhancement?_rsc_action=${encodeURIComponent(actionId)}`,
      ),
      {
        headers: {
          ...crossOriginHeaders(),
          "rsc-action": actionId,
          // The page the call is made from, as the client runtime sends it.
          "X-RSC-Router-Client-Path": pageUrl,
        },
        // encodeReply([formData]): `0` carries the args JSON and `_1_<field>`
        // the FormData argument, so without the guard the action would
        // decode its FormData and store the probe.
        multipart: { "0": '["$K1"]', _1_name: probe },
      },
    );
    expect(rejected.status()).toBe(403);
    expect(rejected.headers()["x-rango-origin-check"]).toBe("failed");

    const after = await (await request.get(pageUrl)).text();
    expect(after).not.toContain(probe);
  });
}

// ---------------------------------------------------------------------------
// Dev
// ---------------------------------------------------------------------------
test.describe("origin guard", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  test.setTimeout(30000);

  realActionCases(f);

  test("cross-origin loader fetch is rejected with 403", async ({
    request,
  }) => {
    const response = await request.get(
      f.url("/fetch-loader?_rsc_loader=src/loaders.tsx%23FetchableTestLoader"),
      { headers: crossOriginHeaders() },
    );

    expect(response.status()).toBe(403);
    expect(response.headers()["x-rango-origin-check"]).toBe("failed");
  });

  test("same-origin loader fetch is allowed", async ({ request }) => {
    const response = await request.get(
      f.url("/fetch-loader?_rsc_loader=src/loaders.tsx%23FetchableTestLoader"),
      {
        headers: {
          Accept: "text/x-component",
          // No Origin header = same-origin or non-browser client
        },
      },
    );

    expect(response.status()).toBe(200);
  });

  test("cross-origin action request is rejected with 403", async ({
    request,
  }) => {
    const response = await request.post(f.url("/?_rsc_action=some-action-id"), {
      headers: {
        ...crossOriginHeaders(),
        "rsc-action": "some-action-id",
      },
    });

    expect(response.status()).toBe(403);
    expect(response.headers()["x-rango-origin-check"]).toBe("failed");
  });

  test("cross-origin POST (PE form) is rejected with 403", async ({
    request,
  }) => {
    const response = await request.post(f.url("/"), {
      headers: {
        Origin: "https://evil.com",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      data: "field=value",
    });

    expect(response.status()).toBe(403);
    expect(response.headers()["x-rango-origin-check"]).toBe("failed");
  });

  test("regular page navigation is not affected", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);
    await expect(testId(page, "index-page")).toBeVisible();
  });

  test("same-origin browser interactions work normally", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/fetch-loader"));
    await waitForHydration(page);

    // Trigger a loader fetch from same-origin browser context
    await testId(page, "fetch-loader-btn-default").click();
    await expect(testId(page, "fetch-loader-data")).toBeVisible({
      timeout: 5000,
    });
    await expect(testId(page, "fetch-loader-message")).toContainText(
      "Fetched via GET",
    );
  });
});

// ---------------------------------------------------------------------------
// Production
// ---------------------------------------------------------------------------
test.describe("origin guard (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  // Discover production hashed loader IDs
  let loaderIds: { fetchable: string };

  test.beforeAll(async ({ request }) => {
    const res = await request.get(f.url("/__test/loader-ids"), {
      headers: { Accept: "application/json" },
    });
    expect(res.status()).toBe(200);
    const json = await res.json();
    loaderIds = json;
  });

  realActionCases(f);

  test("cross-origin loader fetch is rejected with 403", async ({
    request,
  }) => {
    const response = await request.get(
      f.url(
        `/fetch-loader?_rsc_loader=${encodeURIComponent(loaderIds.fetchable)}`,
      ),
      { headers: crossOriginHeaders() },
    );

    expect(response.status()).toBe(403);
    expect(response.headers()["x-rango-origin-check"]).toBe("failed");
  });

  test("same-origin loader fetch is allowed", async ({ request }) => {
    const response = await request.get(
      f.url(
        `/fetch-loader?_rsc_loader=${encodeURIComponent(loaderIds.fetchable)}`,
      ),
      {
        headers: {
          Accept: "text/x-component",
        },
      },
    );

    expect(response.status()).toBe(200);
  });

  test("cross-origin action request is rejected with 403", async ({
    request,
  }) => {
    const response = await request.post(f.url("/?_rsc_action=some-action-id"), {
      headers: {
        ...crossOriginHeaders(),
        "rsc-action": "some-action-id",
      },
    });

    expect(response.status()).toBe(403);
    expect(response.headers()["x-rango-origin-check"]).toBe("failed");
  });

  test("cross-origin POST (PE form) is rejected with 403", async ({
    request,
  }) => {
    const response = await request.post(f.url("/"), {
      headers: {
        Origin: "https://evil.com",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      data: "field=value",
    });

    expect(response.status()).toBe(403);
    expect(response.headers()["x-rango-origin-check"]).toBe("failed");
  });

  test("regular page navigation is not affected", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);
    await expect(testId(page, "index-page")).toBeVisible();
  });

  test("same-origin browser interactions work normally", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/fetch-loader"));
    await waitForHydration(page);

    await testId(page, "fetch-loader-btn-default").click();
    await expect(testId(page, "fetch-loader-data")).toBeVisible({
      timeout: 5000,
    });
    await expect(testId(page, "fetch-loader-message")).toContainText(
      "Fetched via GET",
    );
  });
});
