import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import { expectNoPageError, waitForHydration } from "./helper";
import { guardHydrationErrors, fetchDocument } from "@shared/e2e";

// data-external SSR/browser agreement on workerd (fixture:
// /test/link-external-origin — see pages/link-external-origin.tsx and the
// test-app twin). Pre-fix, isExternalUrl read window.location.origin, the
// server swallowed the ReferenceError, and SSR HTML never carried
// data-external: every absolute-URL <Link> was a hydration mismatch and
// cross-origin links only hard-navigated after the client patched them.

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
    const html = await fetchDocument(f.url("/test/link-external-origin"));
    expect(externalStates(html)).toEqual({
      "link-cross-origin": true,
      "link-same-origin-absolute": false,
      "link-relative-control": false,
    });
  });

  test("hydrates with zero errors and keeps the SSR classification", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    using __ = guardHydrationErrors(page);

    await page.goto(f.url("/test/link-external-origin"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="link-cross-origin"]'),
    ).toHaveAttribute("data-external", "");
    await expect(
      page.locator('[data-testid="link-same-origin-absolute"]'),
    ).not.toHaveAttribute("data-external");
  });
}

test.describe("link external-origin SSR", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  defineSpec(f);
});

test.describe("link external-origin SSR (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  defineSpec(f);
});
