/**
 * dc-t92: an `ssr: false` loader that throws on a document load, on a route
 * with no errorBoundary() on its chain, is answered with the router's default
 * error boundary and a 500: on a plain document, a ppr MISS, and a ppr shell
 * HIT whose loader run throws. Before, the payload carried the error with no
 * fallback. The browser decodes a flagged loader while it builds the tree, so
 * the build rejected above every error boundary (a blank page on the HIT) and
 * the SSR shell failed (the host's raw 500 on the MISS).
 *
 * dc-q61: one status rule. A declared errorBoundary() answers 500 too wherever
 * the status has not gone out (a document, a ppr MISS); a shell HIT keeps the
 * 200 it sent with its shell.
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
      path(
        "/declared-shell",
        Page,
        { name: "declaredShell", ppr: true },
        () => [
          loader(Flagged, { ssr: false }),
          errorBoundary(<p>declared-error</p>),
        ],
      ),
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

/**
 * The server prints the loader's original error once, where the loader ran,
 * whichever boundary renders it; the client gets the masked message.
 */
function expectPrintedOnce(pathname: string): void {
  const prints = vi
    .mocked(console.error)
    .mock.calls.filter(
      (call) =>
        call[1] instanceof Error && call[1].message === "flagged loader down",
    );
  expect(prints).toHaveLength(1);
  expect(prints[0]![0]).toMatch(
    new RegExp(`^\\[RSC\\] Loader error \\(.*\\) ${pathname}:$`),
  );
}

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
    expectPrintedOnce("/plain");
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
    expect(hit.response.status).toBe(200);
    expect(hit.flight).toContain(DEFAULT_UI);
  });
});

describe("an ssr: false loader that throws, with a declared errorBoundary() (dc-q61)", () => {
  it("a document keeps its own fallback and answers 500", async () => {
    const { serve } = setup();
    failing = true;

    const result = await serve("/declared");

    expect(result.response.status).toBe(500);
    expect(result.flight).toContain("declared-error");
    expect(result.flight).not.toContain(DEFAULT_UI);
    expectPrintedOnce("/declared");
  });

  it("a ppr MISS answers 500 and stores no shell", async () => {
    const { serve } = setup();
    failing = true;

    const result = await serve("/declared-shell");

    expect(result.shellStatus).toBe("MISS");
    expect(result.response.status).toBe(500);
    expect(result.flight).toContain("declared-error");
    expect(await result.readEntry()).toBeNull();
  });

  it("a shell HIT keeps the 200 its shell went out with", async () => {
    const { serve } = setup();
    expect((await serve("/declared-shell")).shellStatus).toBe("MISS");
    failing = true;

    const hit = await serve("/declared-shell");

    expect(hit.shellStatus).toBe("HIT");
    expect(hit.response.status).toBe(200);
    expect(hit.flight).toContain("declared-error");
  });
});
