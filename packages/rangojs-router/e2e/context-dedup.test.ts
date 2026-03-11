import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId, expectNoPageError } from "./helper";

/**
 * Context dedup tests - verifies that React context identity is preserved
 * when a third-party package with "use client" exports is imported from
 * both server and client components.
 *
 * Without the client-ref-dedup plugin, the RSC proxy module and the client
 * import resolve to separate module instances in dev mode, causing
 * createContext() to run twice and breaking provider/consumer pairing.
 */

test.describe("context-dedup", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("context value flows from server provider to client consumer", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/context-dedup"));
    await waitForHydration(page);

    // The server layout wraps with ThemeProvider(theme="dark-test-theme").
    // The client consumer reads via useTheme(). If module dedup works,
    // the consumer sees the provider's value. If broken, it sees null
    // and renders "NOT_FOUND".
    await expect(testId(page, "context-dedup-value")).toHaveText(
      "dark-test-theme",
    );
    await expect(testId(page, "context-dedup-value")).not.toHaveText(
      "NOT_FOUND",
    );
  });

  test("SSR renders context value in initial HTML", async ({ request }) => {
    const response = await request.get(f.url("/context-dedup"), {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(response.status()).toBe(200);

    const html = await response.text();
    expect(html).toContain("Context Dedup Test");
    expect(html).toContain("dark-test-theme");
    expect(html).not.toContain("NOT_FOUND");
  });
});

// Production tests don't exercise the client-ref-dedup plugin (it is
// dev-only via apply:"serve"). They verify that the fixture itself works
// in production, where the SSR manifest handles module identity via a
// different mechanism. If the fixture regressed only in prod we'd want
// to know.
test.describe("context-dedup (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("context value flows from server provider to client consumer", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/context-dedup"));
    await waitForHydration(page);

    await expect(testId(page, "context-dedup-value")).toHaveText(
      "dark-test-theme",
    );
    await expect(testId(page, "context-dedup-value")).not.toHaveText(
      "NOT_FOUND",
    );
  });

  test("SSR renders context value in initial HTML", async ({ request }) => {
    const response = await request.get(f.url("/context-dedup"), {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(response.status()).toBe(200);

    const html = await response.text();
    expect(html).toContain("Context Dedup Test");
    expect(html).toContain("dark-test-theme");
    expect(html).not.toContain("NOT_FOUND");
  });
});
