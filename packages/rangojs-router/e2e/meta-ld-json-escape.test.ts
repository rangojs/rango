import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * JSON-LD <script> breakout-escaping tests.
 *
 * MetaTags renders script:ld+json descriptors via dangerouslySetInnerHTML.
 * Without escaping, a string field containing "</script>" closes the tag early
 * and the remainder leaks as raw HTML (and any injected <script> executes).
 * The fix escapes "<"/">"/"&" before injection, so the payload stays inside the
 * script tag, never executes, and the content still re-parses to the original
 * string.
 *
 * The /meta-escape fixture emits a WebSite JSON-LD whose `description` field is
 * the literal "</script><script>window.__pwned=1</script>". The page also
 * carries the root layout's own WebSite JSON-LD, so we locate ours by name.
 */

// Keep in sync with META_ESCAPE_PAYLOAD in
// e2e/test-app/src/urls/hooks.handlers.tsx.
const PAYLOAD = "</script><script>window.__pwned=1</script>";

// The escaped form "<" expects to find in the serialized script text.
const ESCAPED_LT = "\\u003c";

function defineSpec(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`MetaTags JSON-LD escaping (${label})`, () => {
    const f = useFixture({
      root: "./e2e/test-app",
      mode,
    });

    test("escapes </script> so injected script cannot break out or execute", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/meta-escape"));
      await waitForHydration(page);

      // The page rendered normally; nothing leaked into the body as raw HTML.
      await expect(
        page.locator('[data-testid="meta-escape-page"]'),
      ).toBeVisible();

      // (a) The injected <script>window.__pwned=1</script> must NOT have run.
      const pwned = await page.evaluate(
        () => (window as unknown as { __pwned?: unknown }).__pwned,
      );
      expect(pwned).toBeUndefined();

      // Locate our fixture's JSON-LD among the page's ld+json scripts
      // (the root layout emits its own WebSite descriptor too).
      const allJsonLd = await page
        .locator('script[type="application/ld+json"]')
        .allTextContents();
      const fixtureScript = allJsonLd.find((s) => s.includes("Meta Escape"));
      expect(fixtureScript).toBeDefined();
      const content = fixtureScript!;

      // The raw breakout markup must NOT appear verbatim in the script text:
      // "<" is escaped, so a literal "</script>" can never be present.
      expect(content).not.toContain("</script>");
      expect(content).toContain(ESCAPED_LT);

      // (b) The script content re-parses to an object carrying the original,
      // unmodified string. textContent returns the literal \uXXXX escapes,
      // which are valid JSON and decode back to the breakout payload.
      const parsed = JSON.parse(content);
      expect(parsed["@type"]).toBe("WebSite");
      expect(parsed.name).toBe("Meta Escape Test");
      expect(parsed.description).toBe(PAYLOAD);
    });
  });
}

defineSpec("dev");
defineSpec("build");
