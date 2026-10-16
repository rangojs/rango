import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { expectConsole } from "./console-guard.js";

// dc-t92: an ssr: false loader that throws on a document load, with no
// errorBoundary() on its chain, ends on the router's default error boundary:
// on a plain document, a ppr MISS, and a ppr shell HIT whose loader run
// throws. Before the fix the HIT went blank (the browser's tree build rejected
// above every error boundary) and the MISS was the host's raw 500.
//
// Fixture (both apps): the holey-throws routes. The loader throws once the
// probe's generation is bumped; the routes sit in a layout marked
// `holey-layout`. `/holey-throws/bounded` declares an errorBoundary(): the
// comparator that keeps the route's own boundary and its 200.

export interface FlaggedLoaderDefaultBoundaryFixture {
  url: (path: string) => string;
}

const DEFAULT_HEADING = "Internal Server Error";

async function bump(
  page: Page,
  fixture: FlaggedLoaderDefaultBoundaryFixture,
  probe: string,
): Promise<void> {
  const res = await page.request.get(
    fixture.url(`/holey-throws/__bump?probe=${probe}`),
  );
  expect(res.ok()).toBe(true);
  expect(((await res.json()) as { generation: number }).generation).toBe(2);
}

/** The default error boundary in place of the route, the layout kept, hydrated. */
async function expectDefaultErrorBoundary(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { name: DEFAULT_HEADING }),
  ).toBeVisible();
  await expect(page.getByTestId("holey-layout")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
  await expect(page.getByTestId("holey-baked")).toHaveCount(0);
  await expect(page.getByTestId("holey-route-boundary")).toHaveCount(0);
}

export function defineFlaggedLoaderDefaultBoundaryTests(
  fixture: () => FlaggedLoaderDefaultBoundaryFixture,
): void {
  test("a document renders the default error boundary with a 500", async ({
    page,
  }) => {
    const probe = `doc-${randomUUID().slice(0, 8)}`;
    await bump(page, fixture(), probe);

    const response = await page.goto(
      fixture().url(`/holey-throws/document?probe=${probe}`),
    );

    expect(response?.status()).toBe(500);
    await expectDefaultErrorBoundary(page);
  });

  test("a ppr MISS renders the default error boundary with a 500", async ({
    page,
  }) => {
    const probe = `miss-${randomUUID().slice(0, 8)}`;
    await bump(page, fixture(), probe);

    const response = await page.goto(
      fixture().url(`/holey-throws/plain?probe=${probe}`),
    );

    expect(response?.status()).toBe(500);
    await expectDefaultErrorBoundary(page);
  });

  test("a route with an errorBoundary() answers 200 with its own boundary", async ({
    page,
  }) => {
    const probe = `bounded-${randomUUID().slice(0, 8)}`;
    await bump(page, fixture(), probe);

    const response = await page.goto(
      fixture().url(`/holey-throws/bounded?probe=${probe}`),
    );

    expect(response?.status()).toBe(200);
    await expect(page.getByTestId("holey-route-boundary")).toHaveText(
      /^route-boundary: /,
    );
    await expect(page.getByTestId("holey-layout")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
    await expect(
      page.getByRole("heading", { name: DEFAULT_HEADING }),
    ).toHaveCount(0);
  });

  test("a ppr shell HIT whose loader run throws ends on the default error boundary, not a blank page", async ({
    page,
  }) => {
    // The prelude holds the baked value; the run's error replaces it at
    // hydration, as a route errorBoundary() does (dc-t91 case 3a).
    expectConsole(page, { allow: [/Hydration failed/] });
    const probe = `hit-${randomUUID().slice(0, 8)}`;
    const url = fixture().url(`/holey-throws/plain?probe=${probe}`);
    await expect(async () => {
      const res = await page.request.get(url, {
        headers: { Accept: "text/html" },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["x-rango-shell"]).toBe("HIT");
    }).toPass({ timeout: 20_000 });
    await bump(page, fixture(), probe);

    const response = await page.goto(url);

    expect(response?.headers()["x-rango-shell"]).toBe("HIT");
    await expectDefaultErrorBoundary(page);
  });
}
