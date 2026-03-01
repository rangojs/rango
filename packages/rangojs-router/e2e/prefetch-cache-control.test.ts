import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

/**
 * Tests for prefetch Cache-Control headers.
 *
 * The test-app router is configured with:
 *   prefetchCacheControl: "private, max-age=60"
 *
 * Verifies that:
 * - Prefetch requests (with X-Rango-Prefetch header) receive the configured Cache-Control
 * - Navigation requests (without X-Rango-Prefetch) do NOT receive Cache-Control
 * - Full page HTML requests do NOT receive Cache-Control
 */

test.describe("prefetch-cache-control (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("prefetch request gets configured Cache-Control", async () => {
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
    const cc = res.headers.get("cache-control");
    expect(cc).toBe("private, max-age=60");
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
});

test.describe("prefetch-cache-control (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("prefetch request gets configured Cache-Control", async () => {
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
    const cc = res.headers.get("cache-control");
    expect(cc).toBe("private, max-age=60");
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
  });

  test("full page HTML request does not get Cache-Control", async () => {
    const res = await fetch(f.url("/"), {
      headers: { Accept: "text/html" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBeNull();
  });
});
