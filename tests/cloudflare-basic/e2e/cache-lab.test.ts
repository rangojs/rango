import { expect, test, type APIRequestContext } from "@playwright/test";
import { guardHydrationErrors } from "@shared/e2e";
import { useFixture, type Fixture } from "./fixture";
import { expectNoPageError, waitForHydration } from "./helper";

test.describe.configure({ mode: "serial" });

const HTML_HEADERS = { Accept: "text/html" };
const TAGS = {
  catalog: "cache-lab:catalog",
  productAlpha: "cache-lab:product:alpha",
  shell: "cache-lab:shell",
} as const;

interface CacheLabSnapshot {
  alpha: string;
  beta: string;
}

function uniqueProbe(label: string): string {
  return `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseSnapshot(html: string): CacheLabSnapshot {
  function token(id: "alpha" | "beta"): string {
    const match = new RegExp(
      `<article[^>]*data-cache-product="${id}"[^>]*data-cache-token="([^"]+)"`,
    ).exec(html);
    if (!match?.[1]) {
      throw new Error(`No ${id} cache token found in cache-lab HTML`);
    }
    return match[1];
  }

  return { alpha: token("alpha"), beta: token("beta") };
}

function parsePulse(html: string): string {
  const match = /data-live-pulse="([^"]+)"/.exec(html);
  if (!match?.[1]) {
    throw new Error("No live pulse found in cache-lab HTML");
  }
  return match[1];
}

async function fetchSnapshot(
  request: APIRequestContext,
  url: string,
): Promise<{
  pulse: string;
  shell: string | undefined;
  snapshot: CacheLabSnapshot;
}> {
  const response = await request.get(url, { headers: HTML_HEADERS });
  expect(response.status()).toBe(200);
  const html = await response.text();
  return {
    pulse: parsePulse(html),
    shell: response.headers()["x-rango-shell"],
    snapshot: parseSnapshot(html),
  };
}

async function warmToHit(
  request: APIRequestContext,
  url: string,
): Promise<CacheLabSnapshot> {
  await expect(async () => {
    const response = await request.get(url, { headers: HTML_HEADERS });
    expect(response.status()).toBe(200);
    expect(response.headers()["x-rango-shell"]).toBe("HIT");
  }).toPass({ timeout: 30_000, intervals: [500, 1_000] });

  const hit = await fetchSnapshot(request, url);
  expect(hit.shell).toBe("HIT");
  // A HIT means the entry is visible; let any duplicate queued capture finish
  // before the next deliberate invalidation exercises a new generation.
  await new Promise((resolve) => setTimeout(resolve, 250));
  return hit.snapshot;
}

async function invalidate(
  request: APIRequestContext,
  f: Fixture,
  tags: readonly string[],
) {
  const response = await request.post(f.url("/api/cache/invalidate"), {
    data: { tags },
  });
  if (response.ok()) {
    // Keep a newly captured shell's createdAt strictly after the marker time.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return response;
}

function defineCacheLabTests(f: Fixture) {
  test("promised metadata streams after the visible PPR page", async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    using _ = expectNoPageError(page);
    using __ = guardHydrationErrors(page);

    const reset = await invalidate(request, f, [TAGS.catalog, TAGS.shell]);
    expect(reset.status()).toBe(200);

    await page.goto(f.url("/"));
    await waitForHydration(page);
    const previousTitle = await page.title();
    await page.getByTestId("nav-cache-lab").click();

    await expect(page.getByTestId("cache-lab-title")).toBeVisible({
      timeout: 5_000,
    });
    expect(await page.title()).toBe(previousTitle);

    await expect(page.getByTestId("cache-lab-product-alpha")).toBeVisible({
      timeout: 10_000,
    });
    const alphaToken = await page
      .getByTestId("cache-lab-token-alpha")
      .textContent();
    await expect
      .poll(() => page.title(), { timeout: 10_000 })
      .toBe(`Cache Lab - ${alphaToken}`);

    await expect(page).toHaveURL(f.url("/cache-lab"));
  });

  test("PPR shell hits keep products baked while the nested promise advances", async ({
    request,
  }) => {
    test.setTimeout(60_000);
    const url = f.url(`/cache-lab?probe=${uniqueProbe("live-hole")}`);

    const first = await fetchSnapshot(request, url);
    expect(first.shell).toBe("MISS");
    const products = await warmToHit(request, url);

    const hitOne = await fetchSnapshot(request, url);
    const hitTwo = await fetchSnapshot(request, url);
    expect(hitOne.shell).toBe("HIT");
    expect(hitTwo.shell).toBe("HIT");
    expect(hitOne.snapshot).toEqual(products);
    expect(hitTwo.snapshot).toEqual(products);
    expect(hitTwo.pulse).not.toBe(hitOne.pulse);
  });

  test("tag invalidation selectively refreshes use-cache values and their PPR shell", async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    using _ = guardHydrationErrors(page);

    const url = f.url(`/cache-lab?probe=${uniqueProbe("invalidation")}`);

    const first = await fetchSnapshot(request, url);
    expect(first.shell).toBe("MISS");
    const baseline = await warmToHit(request, url);
    expect((await fetchSnapshot(request, url)).snapshot).toEqual(baseline);

    const unknown = await invalidate(request, f, ["cache-lab:unbounded-input"]);
    expect(unknown.status()).toBe(400);
    const afterRejected = await fetchSnapshot(request, url);
    expect(afterRejected.shell).toBe("HIT");
    expect(afterRejected.snapshot).toEqual(baseline);

    await page.goto(url);
    await waitForHydration(page);
    await page.getByTestId("cache-lab-invalidate-alpha").click();
    await expect(
      page.getByTestId("cache-lab-invalidation-status"),
    ).toContainText(TAGS.productAlpha);

    const afterAlpha = await fetchSnapshot(request, url);
    expect(afterAlpha.shell).toBe("MISS");
    expect(afterAlpha.snapshot.alpha).not.toBe(baseline.alpha);
    expect(afterAlpha.snapshot.beta).toBe(baseline.beta);
    const alphaGeneration = await warmToHit(request, url);
    expect(alphaGeneration).toEqual(afterAlpha.snapshot);

    const shellOnly = await invalidate(request, f, [TAGS.shell]);
    expect(shellOnly.status()).toBe(200);
    const afterShell = await fetchSnapshot(request, url);
    expect(afterShell.shell).toBe("MISS");
    expect(afterShell.snapshot).toEqual(alphaGeneration);
    await warmToHit(request, url);

    const catalog = await invalidate(request, f, [TAGS.catalog]);
    expect(catalog.status()).toBe(200);
    const afterCatalog = await fetchSnapshot(request, url);
    expect(afterCatalog.shell).toBe("MISS");
    expect(afterCatalog.snapshot.alpha).not.toBe(alphaGeneration.alpha);
    expect(afterCatalog.snapshot.beta).not.toBe(alphaGeneration.beta);
    const catalogGeneration = await warmToHit(request, url);
    expect(catalogGeneration).toEqual(afterCatalog.snapshot);

    await page.goto(url);
    await waitForHydration(page);
    await expect(page.getByTestId("cache-lab-token-alpha")).toHaveText(
      catalogGeneration.alpha,
    );
    await expect(page.getByTestId("cache-lab-token-beta")).toHaveText(
      catalogGeneration.beta,
    );
    await expect(page).toHaveTitle(`Cache Lab - ${catalogGeneration.alpha}`);
  });

  test("the cache lab remains usable on a mobile viewport", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(f.url(`/cache-lab?probe=${uniqueProbe("mobile")}`));
    await waitForHydration(page);

    await expect(page.getByTestId("cache-lab-title")).toBeVisible();
    await expect(page.getByTestId("cache-lab-product-alpha")).toBeVisible();
    await expect(page.getByTestId("cache-lab-invalidate-alpha")).toBeVisible();
  });
}

test.describe("Cloudflare cache lab (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  defineCacheLabTests(f);
});

test.describe("Cloudflare cache lab (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  defineCacheLabTests(f);
});
