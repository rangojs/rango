import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

/**
 * Tests for prefetch Cache-Control and Vary headers.
 *
 * The test-app router is configured with:
 *   prefetchCacheTTL: 60
 *
 * Prefetch uses fetch() with X-Rango-State + X-Rango-Prefetch headers.
 * Server responds with Vary on custom headers so navigation fetch
 * (same custom headers) matches the cached prefetch response.
 */

test.describe("prefetch-cache-control (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("prefetch request gets configured Cache-Control and Vary", async () => {
    const url = new URL("/", f.url("/"));
    url.searchParams.set("_rsc_partial", "true");

    const res = await fetch(url, {
      headers: {
        "X-Rango-State": "test:1",
        "X-RSC-Router-Client-Path": "/",
        "X-Rango-Prefetch": "1",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=60");
    expect(res.headers.get("vary")).toBe(
      "accept, X-Rango-State, X-RSC-Router-Client-Path, X-Rango-Fragment-Passthrough, X-Rango-Fragment-Recovery",
    );
  });

  test("navigation request does not get Cache-Control", async () => {
    const url = new URL("/", f.url("/"));
    url.searchParams.set("_rsc_partial", "true");

    const res = await fetch(url, {
      headers: {
        "X-Rango-State": "test:1",
        "X-RSC-Router-Client-Path": "/",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBeNull();
    // Navigation responses include X-RSC-Router-Client-Path in Vary
    // (source-dependent diff), unlike prefetch which omits it
    expect(res.headers.get("vary")).toBe(
      "accept, X-Rango-State, X-RSC-Router-Client-Path, X-Rango-Fragment-Passthrough, X-Rango-Fragment-Recovery",
    );
  });

  test("full page HTML request does not get Cache-Control", async () => {
    const res = await fetch(f.url("/"), {
      headers: { Accept: "text/html" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBeNull();
  });

  test("RSC request without _rsc_partial does not get Cache-Control", async () => {
    const url = new URL("/", f.url("/"));
    url.searchParams.set("__rsc", "1");

    const res = await fetch(url, {
      headers: {
        "X-Rango-State": "test:1",
        "X-Rango-Prefetch": "1",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-component");
    // Not partial, so no Cache-Control even with X-Rango-Prefetch
    expect(res.headers.get("cache-control")).toBeNull();
  });

  test("partial navigation RSC payload includes prefetch config", async () => {
    const url = new URL("/blog", f.url("/"));
    url.searchParams.set("_rsc_partial", "true");

    const res = await fetch(url, {
      headers: {
        "X-Rango-State": "test:1",
        "X-RSC-Router-Client-Path": "/",
      },
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    // Router is configured with prefetchCacheTTL: 60 (seconds),
    // which becomes 60000 ms in the metadata payload.
    expect(body).toContain("prefetchCacheTTL");
    // Configured prefetch limits ride along in the same metadata block. These
    // counts ship un-transformed (unlike TTL, which becomes ms), so assert the
    // exact configured value (25/3, not the 100/2 defaults) to prove the option
    // propagated end-to-end, not merely that the field exists.
    expect(body).toMatch(/"prefetchCacheSize"\s*:\s*25\b/);
    expect(body).toMatch(/"prefetchConcurrency"\s*:\s*3\b/);
  });

  test("initial page load RSC payload includes prefetch config", async () => {
    const url = new URL("/", f.url("/"));
    // Full RSC request (not partial, not HTML)
    url.searchParams.set("__rsc", "1");

    const res = await fetch(url, {
      headers: {
        "X-Rango-State": "test:1",
      },
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("prefetchCacheTTL");
    // Configured prefetch limits ride along in the same metadata block. These
    // counts ship un-transformed (unlike TTL, which becomes ms), so assert the
    // exact configured value (25/3, not the 100/2 defaults) to prove the option
    // propagated end-to-end, not merely that the field exists.
    expect(body).toMatch(/"prefetchCacheSize"\s*:\s*25\b/);
    expect(body).toMatch(/"prefetchConcurrency"\s*:\s*3\b/);
  });
});

test.describe("prefetch-cache-control (production)", () => {
  test.setTimeout(120000);

  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("prefetch request gets configured Cache-Control and Vary", async () => {
    const url = new URL("/", f.url("/"));
    url.searchParams.set("_rsc_partial", "true");

    const res = await fetch(url, {
      headers: {
        "X-Rango-State": "test:1",
        "X-RSC-Router-Client-Path": "/",
        "X-Rango-Prefetch": "1",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=60");
    expect(res.headers.get("vary")).toBe(
      "accept, X-Rango-State, X-RSC-Router-Client-Path, X-Rango-Fragment-Passthrough, X-Rango-Fragment-Recovery",
    );
  });

  test("navigation request does not get Cache-Control", async () => {
    const url = new URL("/", f.url("/"));
    url.searchParams.set("_rsc_partial", "true");

    const res = await fetch(url, {
      headers: {
        "X-Rango-State": "test:1",
        "X-RSC-Router-Client-Path": "/",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBeNull();
    expect(res.headers.get("vary")).toBe(
      "accept, X-Rango-State, X-RSC-Router-Client-Path, X-Rango-Fragment-Passthrough, X-Rango-Fragment-Recovery",
    );
  });

  test("full page HTML request does not get Cache-Control", async () => {
    const res = await fetch(f.url("/"), {
      headers: { Accept: "text/html" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBeNull();
  });

  test("RSC request without _rsc_partial does not get Cache-Control", async () => {
    const url = new URL("/", f.url("/"));
    url.searchParams.set("__rsc", "1");

    const res = await fetch(url, {
      headers: {
        "X-Rango-State": "test:1",
        "X-Rango-Prefetch": "1",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-component");
    // Not partial, so no Cache-Control even with X-Rango-Prefetch
    expect(res.headers.get("cache-control")).toBeNull();
  });

  test("partial navigation RSC payload includes prefetch config", async () => {
    const url = new URL("/blog", f.url("/"));
    url.searchParams.set("_rsc_partial", "true");

    const res = await fetch(url, {
      headers: {
        "X-Rango-State": "test:1",
        "X-RSC-Router-Client-Path": "/",
      },
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("prefetchCacheTTL");
    // Configured prefetch limits ride along in the same metadata block. These
    // counts ship un-transformed (unlike TTL, which becomes ms), so assert the
    // exact configured value (25/3, not the 100/2 defaults) to prove the option
    // propagated end-to-end, not merely that the field exists.
    expect(body).toMatch(/"prefetchCacheSize"\s*:\s*25\b/);
    expect(body).toMatch(/"prefetchConcurrency"\s*:\s*3\b/);
  });

  test("initial page load RSC payload includes prefetch config", async () => {
    const url = new URL("/", f.url("/"));
    url.searchParams.set("__rsc", "1");

    const res = await fetch(url, {
      headers: {
        "X-Rango-State": "test:1",
      },
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("prefetchCacheTTL");
    // Configured prefetch limits ride along in the same metadata block. These
    // counts ship un-transformed (unlike TTL, which becomes ms), so assert the
    // exact configured value (25/3, not the 100/2 defaults) to prove the option
    // propagated end-to-end, not merely that the field exists.
    expect(body).toMatch(/"prefetchCacheSize"\s*:\s*25\b/);
    expect(body).toMatch(/"prefetchConcurrency"\s*:\s*3\b/);
  });
});
