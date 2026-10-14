/**
 * A prefetch response carries the browser HTTP cache header only when it
 * succeeded. The client drops a failed prefetch from its own cache, but the
 * click's fetch of the same URL would be answered from the HTTP cache with the
 * error for the header's max-age.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import { createRouter, notFound, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";

const router = createRouter({ id: "prefetch-cc-status", version: "v1" }).routes(
  urls(({ path }) => [
    path("/", () => <p>home</p>, { name: "home" }),
    path("/ok", () => <p>ok</p>, { name: "ok" }),
    path(
      "/boom",
      () => {
        throw new Error("boom");
      },
      { name: "boom" },
    ),
    path(
      "/missing",
      () => {
        notFound("gone");
      },
      { name: "missing" },
    ),
  ]),
);

async function prefetch(url: string, isPrefetch = true) {
  const { response } = await serveShellRequest(router, url, {
    cacheStore: new MemorySegmentCacheStore(),
    partial: { from: "/", prefetch: isPrefetch },
  });
  return response;
}

beforeEach(() => resetShellTestState());

describe("a prefetch response's Cache-Control", () => {
  it("is set on a successful prefetch", async () => {
    const response = await prefetch("/ok");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toMatch(/^private, max-age=/);
  });

  it("is absent when the handler throws (500)", async () => {
    const response = await prefetch("/boom");
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBeNull();
  });

  it("is absent on a not-found (404)", async () => {
    const response = await prefetch("/missing");
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBeNull();
  });

  it("is absent on a navigation, whatever the status", async () => {
    const response = await prefetch("/ok", false);
    expect(response.headers.get("cache-control")).toBeNull();
  });
});
