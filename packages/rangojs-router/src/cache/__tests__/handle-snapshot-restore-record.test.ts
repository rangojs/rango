import { describe, it, expect, vi } from "vitest";

// Same JSON stand-in for the Flight codec as cache-record-loader-pushes.test.ts.
function pluginRscMock() {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    createTemporaryReferenceSet: () => new Set(),
    renderToReadableStream: (value: unknown) => {
      const bytes = encoder.encode(JSON.stringify(value) ?? "null");
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    createFromReadableStream: async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      let result = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        result += decoder.decode(value, { stream: true });
      }
      return JSON.parse(result + decoder.decode());
    },
  };
}
vi.mock("@vitejs/plugin-rsc/rsc/server", pluginRscMock);
vi.mock("@vitejs/plugin-rsc/rsc/client", pluginRscMock);

import { encodeHandles, restoreRecordHandles } from "../handle-snapshot.js";
import { createHandleStore } from "../../server/handle-store.js";
import {
  runInsideLoaderBodyScope,
  runInsideLoaderScope,
} from "../../server/context.js";

describe("restoreRecordHandles", () => {
  it("sets the record authority with no handles blob: a pinned loader's run adds nothing", async () => {
    const store = createHandleStore();
    await restoreRecordHandles(store, {}, () => "pin");

    runInsideLoaderScope(() =>
      runInsideLoaderBodyScope(
        () => store.push("crumbs", "seg1", "live"),
        "Bake",
      ),
    );

    expect(store.getDataForSegment("seg1").crumbs ?? []).toEqual([]);
  });

  it("decodes the blob and restores it with its owners", async () => {
    const store = createHandleStore();
    const handles = await encodeHandles({
      seg1: { crumbs: ["handler", "bake-captured"] },
    });

    await restoreRecordHandles(
      store,
      { handles, handleOwners: { seg1: { crumbs: [null, "Bake"] } } },
      () => "pin",
    );

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      "bake-captured",
    ]);

    runInsideLoaderScope(() =>
      runInsideLoaderBodyScope(
        () => store.push("crumbs", "seg1", "bake-live"),
        "Bake",
      ),
    );
    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      "bake-captured",
    ]);
  });

  it("restores only the segments in keepIds", async () => {
    const store = createHandleStore();
    const handles = await encodeHandles({
      seg1: { crumbs: ["kept"] },
      seg2: { crumbs: ["dropped"] },
    });

    await restoreRecordHandles(
      store,
      { handles },
      undefined,
      new Set(["seg1"]),
    );

    expect(store.getDataForSegment("seg1").crumbs).toEqual(["kept"]);
    expect(store.getDataForSegment("seg2").crumbs).toBeUndefined();
  });
});
