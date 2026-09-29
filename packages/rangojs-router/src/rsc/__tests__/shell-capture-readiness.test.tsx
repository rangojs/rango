/**
 * The PPR capture readiness gate waits for client-reference module loads
 * (issue #949). A client component used as an element type reaches the SSR
 * Flight client as a lazy reference, so the payload settles while its module
 * is still loading; a capture that aborts first finds the shell pinned on it.
 * The wait covers module loads only: holes (a row the frozen input never
 * got, a loading() segment waiting on a masked loader) still postpone.
 *
 * Runs the capture core (captureAndStoreShell: Flight gate, quiesce, store)
 * over the real SSR capture handler: the vendored Flight client resolving
 * client references through plugin-rsc's SSR module loader, and
 * react-dom/static prerender. The Flight input is written by hand in React's
 * row format, so each row and each module load lands at a fixed macrotask
 * count, not at a wall-clock time.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { Fragment, Suspense } from "react";

vi.mock("../../segment-system.js", () => ({
  renderSegments: vi.fn(),
}));

import { renderSegments } from "../../segment-system.js";
import { captureAndStoreShell } from "../shell-capture.js";
import { base64ToBytes } from "../../cache/cf/cf-base64.js";
import { createShellCaptureHandler } from "../../ssr/index.js";
import { createHandleStore } from "../../server/handle-store.js";
import { RecordingShellStore } from "../../cache/shell-snapshot.js";
import type { ShellCacheEntry } from "../../cache/types.js";
import type { SSRModule } from "../types.js";
import { prerender } from "react-dom/static.edge";
import { renderToReadableStream } from "react-dom/server.edge";
import { injectRSCPayload } from "rsc-html-stream/server";
// Before the vendored Flight client: it reads the webpack-style globals.
import "../../testing/internal/flight-client-globals.js";
import { setRequireModule } from "@vitejs/plugin-rsc/core/ssr";
import { createFromReadableStream } from "@vitejs/plugin-rsc/vendor/react-server-dom/client.edge";

const mockedRenderSegments = vi.mocked(renderSegments);

/** Client-reference module loads by id, served through plugin-rsc's loader. */
const moduleLoads = new Map<string, () => Promise<unknown>>();
setRequireModule({
  load: (id: string) => {
    const load = moduleLoads.get(id);
    if (!load) throw new Error(`unexpected client reference "${id}"`);
    return load();
  },
});

/** Resolve after `n` macrotask turns. */
async function afterTasks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** A React element tuple as Flight writes it. */
function el(
  type: string,
  key: string | null,
  props: Record<string, unknown>,
): unknown[] {
  return ["$", type, key, props];
}

/** The import row of a client component, as plugin-rsc's manifest emits it. */
function importRow(id: number, moduleId: string, name: string): string {
  return `${id}:I${JSON.stringify([moduleId, [], name, 1])}`;
}

/** The root row of a document payload over `segments`. */
function rootRow(segments: Array<Record<string, unknown>>): string {
  return `0:${JSON.stringify({ metadata: { pathname: "/", segments } })}`;
}

/**
 * A client module that loads `tasks` macrotasks after the Flight client asks
 * for it: past the payload-settled signal plus POST_QUIESCE_TASK_HOPS (16)
 * when `tasks` is 64.
 */
function slowClientModule(
  moduleId: string,
  tasks: number,
  exports: Record<string, React.FC>,
): { requested: Promise<void> } {
  let markRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  moduleLoads.set(moduleId, async () => {
    markRequested();
    await afterTasks(tasks);
    return exports;
  });
  return { requested };
}

/**
 * A Flight stream that emits each row after its macrotask delay (or once its
 * promise resolves) and never closes, like a capture render whose masked rows
 * never emit.
 */
function flightRows(
  rows: Array<[wait: number | Promise<unknown>, row: string]>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const [wait, row] of rows) {
        await (typeof wait === "number" ? afterTasks(wait) : wait);
        controller.enqueue(encoder.encode(`${row}\n`));
      }
    },
  });
}

/** A capture recording store holding a minimal doc record. */
function recordingWithDocRecord(
  putShell: (key: string, entry: ShellCacheEntry) => Promise<void>,
): RecordingShellStore {
  const recording = new RecordingShellStore({ putShell } as any);
  recording.recordSegmentWrite("doc:localhost/", {
    segments: [{ encoded: "0:null", metadata: { id: "R0" } } as any],
    handles: "",
    expiresAt: Date.now() + 300_000,
  });
  return recording;
}

/**
 * Capture `rscStream` through captureAndStoreShell and return what it stored.
 * captureTimeout is 60s: a gate that waited on a hole would run into the test
 * timeout instead of passing.
 */
async function capture(
  key: string,
  rscStream: ReadableStream<Uint8Array>,
): Promise<{ outcome: string; prelude?: string; postponed?: string | null }> {
  const putShell = vi.fn(async (_key: string, _entry: ShellCacheEntry) => {});
  const ssrModule = {
    captureShellHTML: createShellCaptureHandler({
      createFromReadableStream: (stream) =>
        createFromReadableStream(stream, { serverConsumerManifest: {} }),
      renderToReadableStream: renderToReadableStream as any,
      injectRSCPayload: injectRSCPayload as any,
      loadBootstrapScriptContent: async () => "BOOTSTRAP",
      prerender: prerender as any,
    }),
  } as unknown as SSRModule;
  const outcome = await captureAndStoreShell(
    ssrModule,
    rscStream,
    createHandleStore(),
    {
      // The doc record the capture's match wrote (a capture without one is
      // refused: a HIT could not replay the handler layer).
      _cacheStore: recordingWithDocRecord(putShell),
      _shellImplicitCache: { docKey: "doc:localhost/" },
      _reportBackgroundError: vi.fn(),
      _requestTags: new Set<string>(),
    } as any,
    { key, buildVersion: "test-build", ttl: 300, captureTimeout: 60_000 },
  );
  const entry = putShell.mock.calls[0]?.[1];
  return {
    outcome,
    prelude: entry?.prelude
      ? new TextDecoder().decode(base64ToBytes(entry.prelude))
      : undefined,
    postponed: entry?.postponed,
  };
}

// The document the segment system builds, reduced to what these cases need:
// a segment with loading() renders under the router-owned Suspense
// (LoaderBoundary), any other segment renders with no boundary.
beforeEach(() => {
  mockedRenderSegments.mockImplementation(async (segments) => (
    <html>
      <body>
        {segments.map((segment) =>
          segment.loading !== undefined && segment.loading !== null ? (
            <Suspense key={segment.id} fallback={segment.loading}>
              {segment.component}
            </Suspense>
          ) : (
            <Fragment key={segment.id}>{segment.component}</Fragment>
          ),
        )}
      </body>
    </html>
  ));
});

afterEach(() => {
  mockedRenderSegments.mockReset();
});

describe("capture readiness gate: client-reference module loads (#949)", () => {
  it("stores the shell after a client-reference module the settled payload is still loading", async () => {
    slowClientModule("/src/widget.tsx", 64, {
      Widget: () => <p>WIDGET-CONTENT</p>,
    });
    const result = await capture(
      "/client-module:shell",
      flightRows([
        [0, importRow(1, "/src/widget.tsx", "Widget")],
        [
          0,
          rootRow([
            {
              id: "R0",
              type: "route",
              component: el("main", null, {
                children: [
                  el("h1", "h", { children: "SHELL-CONTENT" }),
                  el("$L1", "w", {}),
                ],
              }),
            },
          ]),
        ],
      ]),
    );

    expect(result.outcome).toBe("stored");
    expect(result.prelude).toContain("SHELL-CONTENT");
    expect(result.prelude).toContain("WIDGET-CONTENT");
  });

  it("keeps a row that lands during the module wait a hole", async () => {
    // A promise under the consumer's own Suspense whose row lands 8 tasks
    // after the Flight client asked for the badge module: after the gate froze
    // (2 quiet hops past the import row) and while the capture still waits on
    // the module. (Handler promises settle before the capture's Flight render
    // starts; this pins the gate itself: the frozen input admits no later
    // row.)
    const badge = slowClientModule("/src/badge.tsx", 64, {
      Badge: () => <p>BADGE-CONTENT</p>,
    });
    const result = await capture(
      "/client-module-physics:shell",
      flightRows([
        [0, importRow(1, "/src/badge.tsx", "Badge")],
        [
          0,
          rootRow([
            {
              id: "R0",
              type: "route",
              component: el("main", null, {
                children: [
                  el("$L1", "b", {}),
                  el("$Sreact.suspense", "p", {
                    fallback: "PHYSICS-FALLBACK",
                    children: "$@2",
                  }),
                ],
              }),
            },
          ]),
        ],
        [badge.requested.then(() => afterTasks(8)), `2:"PHYSICS-HOLE-VALUE"`],
      ]),
    );

    expect(result.outcome).toBe("stored");
    expect(result.prelude).toContain("BADGE-CONTENT");
    expect(result.prelude).toContain("PHYSICS-FALLBACK");
    expect(result.prelude).not.toContain("PHYSICS-HOLE-VALUE");
    expect(result.postponed).not.toBeNull();
  });

  it("does not wait on a loading() segment whose content waits on a masked loader", async () => {
    // Row 1 never arrives. The segment's loading() boundary makes it a hole:
    // the capture stores the fallback without waiting for the 60s deadline.
    const result = await capture(
      "/loading-hole:shell",
      flightRows([
        [
          0,
          rootRow([
            {
              id: "L0",
              type: "layout",
              component: el("h1", null, { children: "LAYOUT-CONTENT" }),
            },
            {
              id: "R0",
              type: "route",
              loading: "ROUTE-LOADING",
              component: "$L1",
            },
          ]),
        ],
      ]),
    );

    expect(result.outcome).toBe("stored");
    expect(result.prelude).toContain("LAYOUT-CONTENT");
    expect(result.prelude).toContain("ROUTE-LOADING");
    expect(result.postponed).not.toBeNull();
  });
});
