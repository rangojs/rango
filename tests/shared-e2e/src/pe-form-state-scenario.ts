import { expect, test, type Page } from "@playwright/test";
import { expectConsole } from "./console-guard.js";

/**
 * A useActionState result rendered for a form submitted before hydration must
 * survive hydration (#1087): the browser entry hands hydrateRoot the form state
 * the PE POST's payload carries. Fixture: pe-form-state.tsx in each app; both
 * apps call this from a dev and a (production) describe.
 */

export interface PeFormStateScenarioOptions {
  url: (pathname: string) => string;
}

/**
 * Hold every script request (module imports in dev, bundles in production)
 * until the returned release runs: the form posts natively, and the POST's
 * document hydrates only when the test lets it. Requests of the abandoned
 * first document fail to continue once the POST navigates away, which is
 * expected.
 */
async function holdScripts(page: Page): Promise<() => void> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() === "script") await released;
    await route.continue().catch(() => {});
  });
  return release;
}

export function runPeFormStateTests(options: PeFormStateScenarioOptions): void {
  const { url } = options;

  test("a result submitted before hydration survives hydration", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const release = await holdScripts(page);

    await page.goto(url("/pe-form-state"), { waitUntil: "commit" });
    const submit = page.getByTestId("pe-fs-submit");
    await expect(submit).toBeVisible();
    await expect(page.getByTestId("pe-fs-hydrated")).toHaveText("no");
    await submit.click();

    // The POST's response: rendered by the server, not yet hydrated.
    const token = page.getByTestId("pe-fs-token");
    await expect(token).toBeVisible();
    await expect(page.getByTestId("pe-fs-hydrated")).toHaveText("no");
    const rendered = await token.textContent();
    expect(rendered).toMatch(/^tok-/);

    // Let this document hydrate: the result is still there, unchanged.
    release();
    await expect(page.getByTestId("pe-fs-hydrated")).toHaveText("yes", {
      timeout: 30000,
    });
    await expect(token).toHaveText(rendered!);
    // Only the hook whose key the POST named claims the form state.
    await expect(page.getByTestId("pe-fs-opaque")).toHaveCount(0);
    expect(pageErrors.filter((m) => /hydrat/i.test(m))).toEqual([]);
  });

  test("a form submitted after hydration still shows its result", async ({
    page,
  }) => {
    await page.goto(url("/pe-form-state"));
    await expect(page.getByTestId("pe-fs-hydrated")).toHaveText("yes", {
      timeout: 30000,
    });
    await expect(page.getByTestId("pe-fs-token")).toHaveCount(0);

    await page.getByTestId("pe-fs-submit").click();
    await expect(page.getByTestId("pe-fs-token")).toHaveText(/^tok-/);
  });

  test("a result Flight cannot serialize renders, then resets on hydration", async ({
    page,
  }) => {
    // The server-rendered result differs from the hook's initial state, so
    // React reports a recoverable hydration mismatch and client-renders.
    expectConsole(page, { allow: [/hydrat|did not match|#4(18|23|25)/i] });
    const release = await holdScripts(page);

    await page.goto(url("/pe-form-state"), { waitUntil: "commit" });
    const submit = page.getByTestId("pe-fs-opaque-submit");
    await expect(submit).toBeVisible();
    await submit.click();

    // The POST's document: HTTP 200 HTML with the result, no error page.
    const opaque = page.getByTestId("pe-fs-opaque");
    await expect(opaque).toHaveText("opaque-result");
    await expect(page.getByTestId("pe-fs-hydrated")).toHaveText("no");

    // The payload could not carry the state: the page hydrates without it.
    release();
    await expect(page.getByTestId("pe-fs-hydrated")).toHaveText("yes", {
      timeout: 30000,
    });
    await expect(opaque).toHaveCount(0);
    await expect(page.getByTestId("pe-fs-opaque-submit")).toBeVisible();
    await expect(page.getByTestId("pe-fs-submit")).toBeVisible();
  });
}
