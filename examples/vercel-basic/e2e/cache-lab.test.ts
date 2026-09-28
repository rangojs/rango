import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  devSpec,
  expectNoPageError,
  prodSpec,
  waitForHydration,
  type Fixture,
} from "./helper.js";

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
    shell: response.headers()["x-rango-shell"],
    pulse: parsePulse(html),
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
    // Ensure a recaptured shell starts after the tag-generation marker.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return response;
}

function runCacheLabSpec(f: Fixture): void {
  test("promised metadata streams after the visible PPR page", async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    using _ = expectNoPageError(page);

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
      .toBe(`Vercel Cache Lab - ${alphaToken}`);

    await expect(page).toHaveURL(f.url("/cache-lab"));
  });

  test("PPR shell hits keep products baked while the live pulse advances", async ({
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
    using _ = expectNoPageError(page);

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
    await expect(page).toHaveTitle(
      `Vercel Cache Lab - ${catalogGeneration.alpha}`,
    );
  });

  // Issue #941: the first HIT after a capture reads the runtime cache and fills
  // the store's shell memo; the next HIT is served from memory, and its tag
  // marker is still read, so an invalidation is seen on the very next request.
  test("PPR shell HITs are served from the shell memo, and a tag invalidation still MISSes next", async ({
    request,
  }) => {
    test.setTimeout(60_000);
    const url = f.url(
      `/cache-lab?probe=${uniqueProbe("shell-memo")}&__perf_debug=1`,
    );
    expect((await fetchSnapshot(request, url)).shell).toBe("MISS");

    let storeRead = "";
    await expect(async () => {
      const response = await request.get(url, { headers: HTML_HEADERS });
      expect(response.headers()["x-rango-shell"]).toBe("HIT");
      storeRead = response.headers()["server-timing"] ?? "";
      await response.text();
    }).toPass({ timeout: 30_000, intervals: [500, 1_000] });
    expect(storeRead).toMatch(/ppr-shell-read;dur=[\d.]+;desc="hit store"/);
    expect(storeRead).toMatch(
      /d1-ppr-shell-memo;dur=[\d.]+;desc="miss size=\d+b"/,
    );
    expect(storeRead).toMatch(/d1-ppr-shell-match;dur=[\d.]+;desc="store"/);

    const memoResponse = await request.get(url, { headers: HTML_HEADERS });
    expect(memoResponse.headers()["x-rango-shell"]).toBe("HIT");
    const memoHit = memoResponse.headers()["server-timing"] ?? "";
    await memoResponse.text();
    expect(memoHit).toMatch(/ppr-shell-read;dur=[\d.]+;desc="hit memo"/);
    expect(memoHit).toMatch(
      /d1-ppr-shell-memo;dur=[\d.]+;desc="hit size=\d+b"/,
    );
    // The route's shell tag: its marker is still checked on the memo hit,
    // through the per-process marker memo the store read just filled.
    expect(memoHit).toMatch(
      /d1-ppr-shell-marker;dur=[\d.]+;desc="tags=[1-9]\d* serial commit-wait=[\d.]+ms memo=(?:fresh|stale)[^"]*"/,
    );
    expect(memoHit).not.toContain("d1-ppr-shell-match");

    const invalidated = await invalidate(request, f, [TAGS.shell]);
    expect(invalidated.status()).toBe(200);
    expect((await fetchSnapshot(request, url)).shell).toBe("MISS");
  });

  // Issue #941: updateTag() sets the fresh-reads cookie on its response. The
  // same user's HITs carrying it read the runtime cache and the tag markers
  // (`hit store`, `memo=bypass … fresh-reads`) instead of the per-process
  // memos, while a request without it is served from the shell memo.
  test("updateTag sets the fresh-reads cookie, and HITs carrying it read past the memos", async ({
    playwright,
    request,
  }) => {
    test.setTimeout(60_000);
    const url = f.url(
      `/cache-lab?probe=${uniqueProbe("fresh-reads")}&__perf_debug=1`,
    );
    const warmToHit = async (headers: Record<string, string>) => {
      await expect(async () => {
        const response = await request.get(url, { headers });
        expect(response.headers()["x-rango-shell"]).toBe("HIT");
        await response.text();
      }).toPass({ timeout: 30_000, intervals: [500, 1_000] });
    };
    expect((await fetchSnapshot(request, url)).shell).toBe("MISS");
    await warmToHit(HTML_HEADERS);

    // A separate client runs the mutation, so `request` never stores the
    // cookie and its plain reads stay cookie-less.
    const mutator = await playwright.request.newContext();
    try {
      const invalidated = await invalidate(mutator, f, [TAGS.shell]);
      expect(invalidated.status()).toBe(200);
      const setCookie = invalidated
        .headersArray()
        .filter((header) => header.name.toLowerCase() === "set-cookie")
        .map((header) => header.value)
        .find((value) => /^[^=]+-fresh=/.test(value));
      // Max-Age: the store's longest memo staleness plus 1 s
      // (VercelCacheStore: the 2 s shell window and marker max-stale cap).
      expect(setCookie).toMatch(
        /^rango-state-fresh=1; Max-Age=3; Path=\/; HttpOnly; SameSite=Lax$/,
      );
      const cookie = setCookie!.split(";")[0]!;
      const withCookie = { ...HTML_HEADERS, cookie };

      expect(
        (await request.get(url, { headers: withCookie })).headers()[
          "x-rango-shell"
        ],
      ).toBe("MISS");
      await warmToHit(HTML_HEADERS);

      const bypass = await request.get(url, { headers: withCookie });
      expect(bypass.headers()["x-rango-shell"]).toBe("HIT");
      const bypassTiming = bypass.headers()["server-timing"] ?? "";
      await bypass.text();
      expect(bypassTiming).toMatch(
        /ppr-shell-read;dur=[\d.]+;desc="hit store"/,
      );
      expect(bypassTiming).toMatch(
        /d1-ppr-shell-marker;dur=[\d.]+;desc="tags=[1-9]\d* serial commit-wait=[\d.]+ms memo=bypass[^"]* fresh-reads"/,
      );

      const plain = await request.get(url, { headers: HTML_HEADERS });
      expect(plain.headers()["x-rango-shell"]).toBe("HIT");
      const plainTiming = plain.headers()["server-timing"] ?? "";
      await plain.text();
      expect(plainTiming).toMatch(/ppr-shell-read;dur=[\d.]+;desc="hit memo"/);
    } finally {
      await mutator.dispose();
    }
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

devSpec("Vercel cache lab", runCacheLabSpec);
prodSpec("Vercel cache lab", runCacheLabSpec);
