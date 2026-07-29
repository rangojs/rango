import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";
import { guardHydrationErrors, fetchDocument } from "@shared/e2e";

// data-external SSR/browser agreement (fixture: /link-behavior/external-origin).
//
// isExternalUrl used to read window.location.origin; on the server the
// ReferenceError was swallowed by the malformed-URL catch, so SSR HTML never
// carried data-external and every absolute-URL <Link> hydrated mismatched —
// the browser then patched the attribute in, and cross-origin links only
// hard-navigated AFTER hydration. The fix threads the request origin into the
// SSR navigation store (same channel as the search seeding), so the server
// classifies absolute URLs exactly as the browser will.

/** The three fixture links' data-external state in a raw HTML string. */
function externalStates(html: string): Record<string, boolean> {
  const states: Record<string, boolean> = {};
  for (const id of [
    "link-cross-origin",
    "link-same-origin-absolute",
    "link-relative-control",
  ]) {
    const tag = html.match(
      new RegExp(`<a\\b[^>]*data-testid="${id}"[^>]*>`),
    )?.[0];
    expect(tag, `anchor ${id} present in SSR HTML`).toBeTruthy();
    states[id] = /\bdata-external(=|[\s>])/.test(tag!);
  }
  return states;
}

function defineSpec(f: Fixture) {
  test("SSR HTML classifies absolute URLs against the request origin", async () => {
    const html = await fetchDocument(f.url("/link-behavior/external-origin"));
    expect(externalStates(html)).toEqual({
      // Genuinely external: the attribute must be IN the document, not
      // patched in after hydration — pre-fix this was absent.
      "link-cross-origin": true,
      // Same-site absolute: internal on the server exactly like the browser
      // will conclude, so the pair agrees.
      "link-same-origin-absolute": false,
      "link-relative-control": false,
    });
  });

  test("hydrates with zero errors and keeps the SSR classification", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    using __ = guardHydrationErrors(page);

    await page.goto(f.url("/link-behavior/external-origin"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="link-cross-origin"]'),
    ).toHaveAttribute("data-external", "");
    await expect(
      page.locator('[data-testid="link-same-origin-absolute"]'),
    ).not.toHaveAttribute("data-external");
  });

  test("same-origin absolute link soft-navigates (no document reload)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/link-behavior/external-origin"));
    await waitForHydration(page);

    const documentLoads: string[] = [];
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame())
        documentLoads.push(request.url());
    });

    await page.locator('[data-testid="link-same-origin-absolute"]').click();
    await expect(page.locator("body")).toContainText("Blog");
    expect(page.url()).toContain("/blog");
    expect(documentLoads).toHaveLength(0);
  });
}

test.describe("link external-origin SSR", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  defineSpec(f);
});

test.describe("link external-origin SSR (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  defineSpec(f);
});
