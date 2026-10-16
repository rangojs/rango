/**
 * dc-t92: an `ssr: false` loader that throws on a document load, on a route
 * with no errorBoundary() on its chain, is answered with the router's default
 * error boundary and a 500: on a plain document, a ppr MISS, and a ppr shell
 * HIT whose loader run throws. Before, the payload carried the error with no
 * fallback. The browser decodes a flagged loader while it builds the tree, so
 * the build rejected above every error boundary (a blank page on the HIT) and
 * the SSR shell failed (the host's raw 500 on the MISS).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { createLoader, createRouter, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";

const DEFAULT_UI = "Internal Server Error";

let failing = false;

/** Carries a promise, so a shell HIT runs it (a pin with a hole). */
const Flagged = createLoader(async () => {
  if (failing) throw new Error("flagged loader down");
  return { value: "flagged-ok", later: Promise.resolve("flagged-later") };
});

function Page(): React.ReactNode {
  return <p>page</p>;
}

function setup() {
  const cacheStore = new MemorySegmentCacheStore();
  const router = createRouter({ cache: { store: cacheStore } }).routes(
    urls(({ path, loader, errorBoundary }) => [
      path("/plain", Page, { name: "plain" }, () => [
        loader(Flagged, { ssr: false }),
      ]),
      path("/shell", Page, { name: "shell", ppr: true }, () => [
        loader(Flagged, { ssr: false }),
      ]),
      path("/declared", Page, { name: "declared" }, () => [
        loader(Flagged, { ssr: false }),
        errorBoundary(<p>declared-error</p>),
      ]),
    ]),
  );
  return {
    serve: (url: string) => serveShellRequest(router, url, { cacheStore }),
  };
}

beforeEach(async () => {
  failing = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
  await resetShellTestState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an ssr: false loader that throws, with no errorBoundary()", () => {
  it("a document renders the router's default error boundary with a 500", async () => {
    const { serve } = setup();
    failing = true;

    const result = await serve("/plain");

    expect(result.response.status).toBe(500);
    expect(result.flight).toContain(DEFAULT_UI);
  });

  it("a ppr MISS renders the router's default error boundary with a 500", async () => {
    const { serve } = setup();
    failing = true;

    const result = await serve("/shell");

    expect(result.shellStatus).toBe("MISS");
    expect(result.response.status).toBe(500);
    expect(result.flight).toContain(DEFAULT_UI);
    // The error page is never stored as the URL's shell.
    expect(await result.readEntry()).toBeNull();
  });

  it("a ppr shell HIT whose loader run throws carries the router's default error boundary", async () => {
    const { serve } = setup();
    const first = await serve("/shell");
    expect(first.shellStatus).toBe("MISS");
    expect(first.flight).not.toContain(DEFAULT_UI);
    failing = true;

    const hit = await serve("/shell");

    expect(hit.shellStatus).toBe("HIT");
    expect(hit.flight).toContain(DEFAULT_UI);
  });

  it("a declared errorBoundary() keeps its own fallback and status", async () => {
    const { serve } = setup();
    failing = true;

    const result = await serve("/declared");

    expect(result.response.status).toBe(200);
    expect(result.flight).toContain("declared-error");
    expect(result.flight).not.toContain(DEFAULT_UI);
  });
});
