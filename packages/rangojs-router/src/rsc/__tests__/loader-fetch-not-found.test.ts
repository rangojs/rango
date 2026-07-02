import { describe, it, expect, vi } from "vitest";

// Endpoint contract for an unregistered loader id: getLoaderLazy resolving to
// undefined (genuinely-unknown id — including a hashed production id that is in
// neither the in-memory registry nor the lazy manifest) must map to a clean 404
// "not found in registry", NOT a 500, and must NOT fire onError. This is the
// consumer-observable half of the production gate added to getLoaderLazy (which
// returns undefined instead of attempting a misleading import("/<hash>")).

vi.mock("../../server/loader-registry.js", () => ({
  getLoaderLazy: vi.fn(async () => undefined),
}));

vi.mock("../helpers.js", () => ({
  createResponseWithMergedHeaders: (body: any, init: any) =>
    new Response(body, init),
  finalizeResponse: (r: Response) => r,
}));

import { handleLoaderFetch } from "../loader-fetch";

function createMockHandlerCtx(onError: ReturnType<typeof vi.fn>) {
  return {
    renderToReadableStream: () => new ReadableStream(),
    callOnError: onError,
    getRequiredRouteMap: () => ({}),
  } as any;
}

describe("handleLoaderFetch — unregistered loader id", () => {
  it("returns 404 (not 500) and does not fire onError when getLoaderLazy resolves undefined", async () => {
    const onError = vi.fn();
    const url = new URL(
      "http://localhost/products?_rsc_loader=deadbeef%23NonexistentLoader",
    );
    const request = new Request(url.href, {
      headers: { Accept: "text/x-component" },
    });

    const res = await handleLoaderFetch(
      createMockHandlerCtx(onError),
      request,
      {},
      url,
      {},
    );

    // A genuinely-unknown loader is a not-found, not a server error.
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("not found in registry");

    // No telemetry noise: an unknown id is not an error condition.
    expect(onError).not.toHaveBeenCalled();
  });
});
