import { describe, it, expect, vi } from "vitest";

vi.mock("@vitejs/plugin-rsc/rsc", () => ({
  renderToReadableStream: vi.fn(),
  createFromReadableStream: vi.fn(),
  createTemporaryReferenceSet: vi.fn(),
}));

import { buildFullPayload } from "../full-payload.js";
import { deriveShellCaptureContext } from "../shell-capture.js";
import {
  runInsideLoaderBodyScope,
  runInsideLoaderScope,
} from "../../server/context.js";
import {
  createRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import type { HandleData } from "../../server/handle-store.js";

// Issue #1035: what a PPR shell capture does with a deferred (thenable)
// handle push by a loader. Its record leaves the push out, so the capture's
// own render must leave it out too: a HIT restores the record and hydrates
// with exactly what the prelude was rendered from.

function requestContext(): RequestContext<any> {
  const request = new Request("https://example.com/p", {
    headers: { accept: "text/html" },
  });
  return createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
  } as any);
}

function capture() {
  return deriveShellCaptureContext(requestContext(), { ttl: 60, swr: 0 });
}

/**
 * A promise as Flight decodes one out of a cache entry: React's chunk is a
 * thenable whose then() returns nothing.
 */
function flightPromise<T>(value: T): PromiseLike<T> {
  return {
    then(resolve: (value: T) => unknown): void {
      resolve(value);
    },
  } as PromiseLike<T>;
}

/** The handles a payload carries for the render that reads it. */
async function payloadHandles(
  reqCtx: RequestContext<any>,
  handleStore: RequestContext<any>["_handleStore"],
): Promise<HandleData> {
  const payload = buildFullPayload(
    { segments: [], matched: [], params: {} } as any,
    { router: {}, version: "test" } as any,
    new URL("https://example.com/p"),
    reqCtx,
    handleStore,
  );
  let last: HandleData = {};
  for await (const data of payload.metadata!.handles!) last = data;
  return last;
}

describe("shell capture: a deferred loader push", () => {
  it("keeps the value a loader's cache() entry replays as a promise of it", async () => {
    const { freshHandleStore } = capture();

    // loader-cache.ts replayLoaderHandles: outside the loader's body.
    runInsideLoaderScope(() => {
      freshHandleStore.pushReplayed(
        "notes",
        "seg1",
        flightPromise("deferred"),
        "Loader",
      );
    });

    const [slot] = freshHandleStore.getDataForSegment("seg1").notes!;
    expect(await slot).toBe("deferred");
    // Still out of the record: a HIT delivers it from the loader's source.
    expect(freshHandleStore.getDataForSegment("seg1", true).notes).toBe(
      undefined,
    );
  });

  it("is not in the handle data the capture's payload renders from", async () => {
    const { derivedCtx, freshHandleStore } = capture();
    freshHandleStore.push("notes", "seg1", "handler");
    runInsideLoaderScope(() =>
      runInsideLoaderBodyScope(() => {
        freshHandleStore.push("notes", "seg1", "settled");
        freshHandleStore.push("notes", "seg1", Promise.resolve("deferred"));
        freshHandleStore.push("notes", "seg1", {
          label: "nested",
          later: Promise.resolve("live"),
        });
      }, "Loader"),
    );

    expect(await payloadHandles(derivedCtx, freshHandleStore)).toEqual({
      notes: { seg1: ["handler", "settled"] },
    });
    // The payload renders what the record keeps, value for value.
    expect(freshHandleStore.getDataForSegment("seg1", true)).toEqual({
      notes: ["handler", "settled"],
    });
  });

  it("a document render that is not a capture carries every push", async () => {
    const reqCtx = requestContext();
    const store = reqCtx._handleStore;
    runInsideLoaderScope(() =>
      runInsideLoaderBodyScope(() => {
        store.push("notes", "seg1", "settled");
        store.push("notes", "seg1", Promise.resolve("deferred"));
      }, "Loader"),
    );

    expect(await payloadHandles(reqCtx, store)).toEqual({
      notes: { seg1: ["settled", "deferred"] },
    });
  });
});
