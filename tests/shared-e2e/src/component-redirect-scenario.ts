import { expect, test, type Page } from "@playwright/test";

// An async server component that checks the session and throws redirect()
// for a signed-out visitor, after its handler returned. It used to end on the
// router's error page, on a document load and on a client navigation alike.
// Now a document load whose shell it fails answers a real 3xx; behind
// <Suspense>, or with location state, the document answers 200 and the
// browser replaces it with the target, as a loader's redirect() does; a
// client navigation lands on the target.
//
// Fixture (both apps): /component-redirect/* in component-redirect.tsx.

export interface ComponentRedirectFixture {
  url: (path: string) => string;
}

const ERROR_PAGE_TEXT =
  "An unexpected error occurred while processing your request.";

/** Records whether the router's error page was ever in the DOM. */
async function watchForErrorPage(page: Page): Promise<void> {
  await page.addInitScript((text) => {
    const flag = window as unknown as { __crErrorPageSeen?: boolean };
    flag.__crErrorPageSeen = false;
    const check = (): void => {
      if (document.body?.textContent?.includes(text)) {
        flag.__crErrorPageSeen = true;
      }
    };
    new MutationObserver(check).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }, ERROR_PAGE_TEXT);
}

async function errorPageSeen(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      (window as unknown as { __crErrorPageSeen?: boolean })
        .__crErrorPageSeen === true,
  );
}

async function expectLogin(page: Page, flash = "none"): Promise<void> {
  await expect(page).toHaveURL(/\/component-redirect\/login$/);
  await expect(page.getByTestId("cr-login")).toBeVisible();
  await expect(page.getByTestId("cr-login-flash")).toHaveText(flash);
  expect(await errorPageSeen(page)).toBe(false);
}

async function rawDocument(
  page: Page,
  fixture: ComponentRedirectFixture,
  path: string,
): Promise<{ status: number; location: string | undefined; body: string }> {
  const res = await page.request.get(fixture.url(path), {
    headers: { Accept: "text/html" },
    maxRedirects: 0,
  });
  return {
    status: res.status(),
    location: res.headers().location,
    body: await res.text(),
  };
}

async function clickFromHome(
  page: Page,
  fixture: ComponentRedirectFixture,
  link: string,
): Promise<void> {
  await page.goto(fixture.url("/component-redirect"));
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
  await page.getByTestId(link).click();
}

export function defineComponentRedirectTests(
  fixture: () => ComponentRedirectFixture,
): void {
  test.beforeEach(async ({ page }) => {
    await watchForErrorPage(page);
  });

  test("a signed-out document load answers a real redirect to the sign-in page", async ({
    page,
  }) => {
    const f = fixture();

    const raw = await rawDocument(page, f, "/component-redirect/account");

    expect(raw.status).toBe(302);
    expect(raw.location).toMatch(/\/component-redirect\/login$/);
    expect(raw.body).toBe("");
    await page.goto(f.url("/component-redirect/account"));
    await expectLogin(page);
  });

  test("a signed-out click from the home page lands on the sign-in page", async ({
    page,
  }) => {
    const f = fixture();

    await clickFromHome(page, f, "cr-link-account");

    await expectLogin(page);
  });

  test("behind <Suspense>: the document, then the replace to the sign-in page; a click lands there too", async ({
    page,
  }) => {
    const f = fixture();

    const raw = await rawDocument(page, f, "/component-redirect/suspense");
    expect(raw.status).toBe(200);
    expect(raw.body).toContain('data-testid="cr-pending"');

    await page.goto(f.url("/component-redirect/suspense"));
    await expectLogin(page);

    await clickFromHome(page, f, "cr-link-suspense");
    await expectLogin(page);
  });

  test("a redirect with state carries it to the sign-in page, on a document load and a click", async ({
    page,
  }) => {
    const f = fixture();

    const raw = await rawDocument(page, f, "/component-redirect/state");
    // The state rides the history entry the client replace writes, which a
    // 3xx cannot carry.
    expect(raw.status).toBe(200);

    await page.goto(f.url("/component-redirect/state"));
    await expectLogin(page, "sign in first");

    await clickFromHome(page, f, "cr-link-state");
    await expectLogin(page, "sign in first");
  });

  test("a signed-in visitor sees the account page", async ({
    page,
    context,
  }) => {
    const f = fixture();
    await context.addCookies([
      { name: "cr-session", value: "ada", url: f.url("/") },
    ]);

    await page.goto(f.url("/component-redirect/account"));
    await expect(page.getByTestId("cr-summary")).toHaveText("signed in as ada");

    await clickFromHome(page, f, "cr-link-suspense");
    await expect(page).toHaveURL(/\/component-redirect\/suspense$/);
    await expect(page.getByTestId("cr-summary")).toHaveText("signed in as ada");
    expect(await errorPageSeen(page)).toBe(false);
  });
}
