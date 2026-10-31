import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { guardHydrationErrors } from "./hydration-guard.js";

/**
 * Location state on document responses (#1330). The fixture
 * (document-location-state.tsx in each app) has `/doc-state` (two no-JS
 * forms: one redirects with a flash, one sets it and is answered with the
 * page), `/doc-state/target`, `/doc-state/callback` (a handler redirect with
 * a flash: a payment provider sending the shopper back) and
 * `/doc-state/verify` (a handler that sets a flash on the page itself: an
 * email link), and `/doc-state/shell` (a `ppr` page) with
 * `/doc-state/shell-callback` redirecting to it with a flash, search kept.
 * Every page shows the flash (`ds-flash`, "none" without one)
 * and whether it has hydrated (`ds-hydrated`). Both apps call this from a dev
 * and a (production) describe.
 */

export interface DocumentLocationStateScenarioOptions {
  url: (pathname: string) => string;
}

/**
 * Hold every script request until the returned release runs, so a form
 * posts natively (no JS) and the POST's documents hydrate only when the test
 * lets them. Requests of an abandoned document fail to continue once it
 * navigates away, which is expected.
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

async function expectHydrated(page: Page): Promise<void> {
  await expect(page.getByTestId("ds-hydrated")).toHaveText("yes", {
    timeout: 30000,
  });
}

async function stateCookies(page: Page): Promise<string[]> {
  return (await page.context().cookies())
    .map((cookie) => cookie.name)
    .filter((name) => name.endsWith("-ls"));
}

export function runDocumentLocationStateTests(
  options: DocumentLocationStateScenarioOptions,
): void {
  const { url } = options;

  test("a page load whose handler sets a flash shows it once hydrated, sent private", async ({
    page,
  }) => {
    const response = await page.goto(url("/doc-state/verify"));
    expect(response?.headers()["cache-control"]).toBe("private, no-store");
    await expectHydrated(page);
    await expect(page.getByTestId("ds-flash")).toHaveText("email verified");
    // Flash: read once, then gone from the entry.
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(window.history.state ?? {}).some((key) =>
            key.endsWith("#DocumentFlash"),
          ),
        ),
      )
      .toBe(false);
  });

  test("a document redirect carries its flash to the target once; a refresh does not repeat it", async ({
    page,
  }) => {
    await page.goto(url("/doc-state/callback"));
    await expect(page).toHaveURL(url("/doc-state/target"));
    await expectHydrated(page);
    await expect(page.getByTestId("ds-flash")).toHaveText("payment declined");
    // The target's response cleared the one-shot cookie.
    expect(await stateCookies(page)).toEqual([]);

    await page.reload();
    await expectHydrated(page);
    await expect(page.getByTestId("ds-flash")).toHaveText("none");
  });

  test("a document redirect's flash rides the live tail of a ppr target's shell HIT, once", async ({
    page,
  }) => {
    // A shell of this test's own: the probe keys it.
    const shellPath = `/doc-state/shell?probe=${randomUUID()}`;
    const shellStatus = async (): Promise<string | undefined> => {
      const response = await page.request.get(url(shellPath), {
        headers: { Accept: "text/html" },
      });
      expect(response.status()).toBe(200);
      return response.headers()["x-rango-shell"];
    };
    expect(await shellStatus()).toBe("MISS");
    // The capture runs in the background of the MISS.
    await expect(async () => {
      expect(await shellStatus()).toBe("HIT");
    }).toPass({ timeout: 20_000 });

    using _ = guardHydrationErrors(page);
    // goto resolves with the redirect target's response: the shell HIT.
    const landed = await page.goto(
      url(shellPath.replace("/doc-state/shell", "/doc-state/shell-callback")),
    );
    await expect(page).toHaveURL(url(shellPath));
    expect(landed?.headers()["x-rango-shell"]).toBe("HIT");
    expect(landed?.headers()["cache-control"]).toBe("private, no-store");
    await expectHydrated(page);
    await expect(page.getByTestId("ds-flash")).toHaveText("shell flash");
    // The HIT read the one-shot cookie and cleared it.
    expect(await stateCookies(page)).toEqual([]);

    // A refresh is a plain HIT of the shared shell, without the flash.
    const reloaded = await page.reload();
    expect(reloaded?.headers()["x-rango-shell"]).toBe("HIT");
    expect(reloaded?.headers()["cache-control"]).not.toBe("private, no-store");
    await expectHydrated(page);
    await expect(page.getByTestId("ds-flash")).toHaveText("none");
  });

  test("a no-JS form post that redirects shows its flash on the target", async ({
    page,
  }) => {
    const release = await holdScripts(page);
    await page.goto(url("/doc-state"), { waitUntil: "commit" });
    const submit = page.getByTestId("ds-redirect-submit");
    await expect(submit).toBeVisible();
    await expect(page.getByTestId("ds-hydrated")).toHaveText("no");
    const posted = page.waitForResponse(
      (response) => response.request().method() === "POST",
    );
    await submit.click();
    const answer = await posted;
    expect(answer.status()).toBe(303);
    expect(answer.headers()["cache-control"]).toBe("private, no-store");

    // The 303's target, rendered by the server, not yet hydrated.
    await expect(page).toHaveURL(url("/doc-state/target"));
    await expect(page.getByTestId("ds-flash")).toHaveText("none");

    release();
    await expectHydrated(page);
    await expect(page.getByTestId("ds-flash")).toHaveText("paid without js");
    expect(await stateCookies(page)).toEqual([]);
  });

  test("a no-JS form post answered with the page shows its flash once hydrated", async ({
    page,
  }) => {
    const release = await holdScripts(page);
    await page.goto(url("/doc-state"), { waitUntil: "commit" });
    const submit = page.getByTestId("ds-inplace-submit");
    await expect(submit).toBeVisible();
    const posted = page.waitForResponse(
      (response) => response.request().method() === "POST",
    );
    await submit.click();

    // The POST's document: the page again, sent private.
    const answer = await posted;
    expect(answer.status()).toBe(200);
    expect(answer.headers()["cache-control"]).toBe("private, no-store");

    release();
    await expectHydrated(page);
    await expect(page.getByTestId("ds-flash")).toHaveText("saved without js");
  });
}
