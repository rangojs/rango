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
import { pushedByKey } from "../../handles/pushed-by.js";

// What a PPR shell capture does with a deferred (thenable) handle push by a
// loader. A bake-lane body's promise is owned by its loader and judged by
// its settled value (#1182): the record keeps it, resolved, unless it
// settles to a value that holds a promise. The capture's own render keeps
// exactly what the record keeps (#1035): a HIT restores the record and
// hydrates with what the prelude was rendered from.

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
  it("owns the value a loader's cache() entry replays as a promise of it, for the loader the replay names", async () => {
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
    expect(freshHandleStore.getDataForSegment("seg1", true).notes).toEqual([
      slot,
    ]);
    expect(freshHandleStore.getRecordOwners("seg1")).toEqual({
      notes: ["Loader"],
    });
  });

  it("is in the handle data the capture's payload renders from, resolved; a push holding a promise is not", async () => {
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
      notes: { seg1: ["handler", "settled", "deferred"] },
      [pushedByKey("notes")]: { seg1: [null, "Loader", "Loader"] },
    });
    // The payload renders what the record keeps, value for value.
    const recorded = freshHandleStore.getDataForSegment("seg1", true).notes!;
    expect(await Promise.all(recorded)).toEqual([
      "handler",
      "settled",
      "deferred",
    ]);
    expect(derivedCtx._shellCaptureState?.unrecordedLoaderPush).toBe(true);
  });

  it("leaves out a promise that settles to a value holding one, and asks the loader records for a run", async () => {
    const { derivedCtx, freshHandleStore, loaderPromisePushes } = capture();
    let slot: unknown;
    runInsideLoaderScope(() =>
      runInsideLoaderBodyScope(() => {
        freshHandleStore.push(
          "notes",
          "seg1",
          Promise.resolve({ label: "nested", later: Promise.resolve("live") }),
        );
        [slot] = freshHandleStore.getDataForSegment("seg1").notes!;
      }, "Loader"),
    );
    // Owned while it is pending: the record-first step waits for it.
    expect(freshHandleStore.getDataForSegment("seg1", true).notes).toEqual([
      slot,
    ]);
    expect(derivedCtx._shellCaptureState?.unrecordedLoaderPush).toBeFalsy();

    await slot;

    expect(freshHandleStore.getDataForSegment("seg1", true).notes).toBe(
      undefined,
    );
    expect(freshHandleStore.getRecordOwners("seg1")).toBeUndefined();
    expect(derivedCtx._shellCaptureState?.unrecordedLoaderPush).toBe(true);
    expect(loaderPromisePushes).toEqual([
      { loaderId: "Loader", handleName: "notes", state: "fulfilled" },
    ]);
  });

  it("records a rejected promise for the refusal and leaves no unhandled rejection", async () => {
    const { freshHandleStore, loaderPromisePushes } = capture();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      runInsideLoaderScope(() =>
        runInsideLoaderBodyScope(() => {
          const rejected = Promise.reject(new Error("seo down"));
          rejected.catch(() => {});
          freshHandleStore.push("notes", "seg1", rejected);
        }, "Loader"),
      );
      // A tagged slot (no body or replay names it) handles its own.
      runInsideLoaderScope(() => {
        const rejected = Promise.reject(new Error("no owner"));
        rejected.catch(() => {});
        freshHandleStore.push("notes", "seg2", rejected);
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(loaderPromisePushes).toEqual([
        { loaderId: "Loader", handleName: "notes", state: "rejected" },
      ]);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
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
      [pushedByKey("notes")]: { seg1: ["Loader", "Loader"] },
    });
  });
});
