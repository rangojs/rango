import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId } from "./helper";

/**
 * Named catch-all params (issue #634).
 *
 * `:slug*` (zero-or-more) and `:path+` (one-or-more) expose the matched
 * remainder as a single decoded string at `ctx.params.<name>` with separators
 * preserved. Runs in both dev and production; the production trie is serialized
 * by the Vite plugin, so this pins that the dev (per-request rebuild) and
 * production (serialized) matchers agree on the new modifier.
 */
function catchAllTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`catch-all (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });

    test(":slug* (zero-or-more) captures a multi-segment remainder", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/catch-all/docs/getting-started/install"));
      await expect(testId(page, "catchall-docs-slug")).toHaveText(
        "getting-started/install",
      );
      await expect(testId(page, "catchall-docs-empty")).toHaveText("nonempty");
    });

    test(":slug* captures a single segment", async ({ page }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/catch-all/docs/intro"));
      await expect(testId(page, "catchall-docs-slug")).toHaveText("intro");
    });

    test(":slug* (zero-or-more) matches the bare prefix, binding an empty string", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/catch-all/docs"));
      await expect(testId(page, "catchall-docs-heading")).toHaveText("Docs");
      await expect(testId(page, "catchall-docs-empty")).toHaveText("empty");
    });

    test("reverse() round-trips a catch-all with separators preserved", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/catch-all/docs/x"));
      await expect(testId(page, "catchall-docs-reverse")).toHaveText(
        "/catch-all/docs/a/b",
      );
    });

    test(":path+ (one-or-more) captures a multi-segment remainder", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/catch-all/shop/electronics/phones"));
      await expect(testId(page, "catchall-shop-path")).toHaveText(
        "electronics/phones",
      );
    });

    test(":path+ captures a single trailing segment", async ({ page }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/catch-all/shop/sale"));
      await expect(testId(page, "catchall-shop-path")).toHaveText("sale");
    });

    // Review F10: the ONLY behavioral difference between `+` and `*` is the
    // bare-prefix case. `:slug*` matches it; `:path+` must not. In production the
    // trie is JSON-serialized, so this also guards that the `w1` (one-or-more)
    // flag survives serialization — if it were dropped, `+` would degrade to `*`
    // and wrongly render the shop route here.
    test(":path+ rejects the bare prefix while :slug* accepts it", async ({
      page,
    }) => {
      await page.goto(f.url("/catch-all/docs"));
      await expect(testId(page, "catchall-docs-heading")).toHaveText("Docs");

      const res = await page.goto(f.url("/catch-all/shop"));
      await expect(testId(page, "catchall-shop-heading")).toHaveCount(0);
      expect(res?.status()).toBe(404);
    });
  });
}

catchAllTests("dev");
catchAllTests("build");
