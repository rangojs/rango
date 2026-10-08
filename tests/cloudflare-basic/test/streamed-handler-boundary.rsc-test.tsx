// Dogfood: /streamed-handler-boundary (e2e/streamed-handler-boundary.test.ts)
// in-process through serveShellRequest. The route pieces are the app's own
// (pages/streamed-handler-boundary.tsx); the router is rebuilt here because
// src/router.tsx does not import in bare Vitest (test/FINDINGS.md).
import { describe, expect, it, vi } from "vitest";
import { createRouter, urls } from "@rangojs/router";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";
import { serveShellRequest } from "@rangojs/router/testing/flight";
import {
  StreamedHandlerBoundaryError,
  StreamedHandlerBoundaryFails,
  StreamedHandlerBoundaryLoading,
  StreamedHandlerBoundaryMissing,
  StreamedHandlerBoundaryNotFound,
} from "../src/pages/streamed-handler-boundary.js";

function build() {
  const onError = vi.fn();
  const router = createRouter({ onError }).routes(
    urls(({ path, loading, errorBoundary, notFoundBoundary }) => [
      path("/fails", StreamedHandlerBoundaryFails, { name: "fails" }, () => [
        loading(<StreamedHandlerBoundaryLoading id="shb-fails" />),
        errorBoundary(() => <StreamedHandlerBoundaryError id="shb-fails" />),
      ]),
      path(
        "/missing",
        StreamedHandlerBoundaryMissing,
        { name: "missing" },
        () => [
          loading(<StreamedHandlerBoundaryLoading id="shb-missing" />),
          notFoundBoundary(() => <StreamedHandlerBoundaryNotFound />),
        ],
      ),
      path(
        "/undeclared",
        StreamedHandlerBoundaryFails,
        { name: "undeclared" },
        () => [loading(<StreamedHandlerBoundaryLoading id="shb-undeclared" />)],
      ),
    ]),
  );
  return { router, onError };
}

const serve = (
  router: ReturnType<typeof build>["router"],
  url: string,
  partial?: true | { from: string },
) =>
  serveShellRequest(router, url, {
    cacheStore: new MemorySegmentCacheStore(),
    ...(partial ? { partial } : {}),
  });

describe("streamed handler declared boundary (cloudflare-basic)", () => {
  it("document and navigation render the declared errorBoundary; onError fires once each", async () => {
    const { router, onError } = build();
    const doc = await serve(router, "/fails");
    expect(doc.response.status).toBe(200);
    expect(doc.flight).toContain("shb-fails-fallback");
    expect(onError).toHaveBeenCalledTimes(1);

    const nav = await serve(router, "/fails", { from: "/undeclared" });
    expect(nav.flight).toContain("shb-fails-fallback");
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("document and navigation render the declared notFoundBoundary", async () => {
    const { router } = build();
    const doc = await serve(router, "/missing");
    expect(doc.response.status).toBe(200);
    expect(doc.flight).toContain("shb-missing-fallback");
    const nav = await serve(router, "/missing", { from: "/fails" });
    expect(nav.flight).toContain("shb-missing-fallback");
  });

  it("with no declared boundary the rejection stays an error row in the stream", async () => {
    const { router } = build();
    const doc = await serve(router, "/undeclared");
    expect(doc.flight).not.toContain("fallback");
    expect(doc.flight).toMatch(/^\d+:E\{/m);
  });
});
