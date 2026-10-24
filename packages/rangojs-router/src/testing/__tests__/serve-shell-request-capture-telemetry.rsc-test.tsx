/**
 * Telemetry of a PPR shell MISS through the production request handler
 * (serveShellRequest): the background shell capture sends nothing to the
 * sink, so the visitor's request reports one id and every loader.start it
 * reports is followed by its loader.end.
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
import {
  createHandle,
  createLoader,
  createRouter,
  urls,
  type TelemetryEvent,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { navigationShellKey } from "../../rsc/shell-capture-constants.js";

const events: TelemetryEvent[] = [];

const PageLoader = createLoader(async () => ({ page: 1 }));
const Notes = createHandle<string>();

// Resolved after serveShellRequest returns: each run's handler (the visitor's
// and the capture's) then pushes after its handle collection completed.
let releaseLatePush!: () => void;
let latePush!: Promise<void>;

const router = createRouter({
  telemetry: { emit: (event) => events.push(event) },
}).routes(
  urls(({ path, loader }) => [
    path(
      "/ppr",
      () => <main>ppr page</main>,
      { name: "ppr", ppr: true },
      () => [loader(PageLoader)],
    ),
    path(
      "/late-push",
      (ctx) => {
        const push = ctx.use(Notes);
        void latePush.then(() => {
          try {
            push("late");
          } catch {}
        });
        return <main>late push page</main>;
      },
      { name: "latePush", ppr: true },
    ),
  ]),
);

function eventIds(): Array<[TelemetryEvent["type"], string | undefined]> {
  return events.map((event) => [event.type, event.requestId]);
}

function expectVisitorEventsOnly(): void {
  const start = events.find((event) => event.type === "request.start")!;
  expect(start.requestId).toMatch(/^t-/);
  for (const [type, requestId] of eventIds()) {
    expect([type, requestId]).toEqual([type, start.requestId]);
  }
  const types = events.map((event) => event.type);
  expect(types.filter((type) => type === "request.start")).toHaveLength(1);
  expect(types.filter((type) => type === "loader.start")).toEqual([
    "loader.start",
  ]);
  expect(types.filter((type) => type === "loader.end")).toEqual(["loader.end"]);
}

beforeEach(() => {
  resetShellTestState();
  events.length = 0;
  latePush = new Promise((resolve) => {
    releaseLatePush = resolve;
  });
});

describe("telemetry of a PPR shell capture", () => {
  it("a document shell MISS reports only the visitor's events, under one requestId", async () => {
    const result = await serveShellRequest(router, "/ppr", {
      cacheStore: new MemorySegmentCacheStore(),
    });

    expect(result.shellStatus).toBe("MISS");
    expect(await result.readEntry()).not.toBeNull();
    expectVisitorEventsOnly();
  });

  it("a navigation shell MISS reports only the visitor's events, under one requestId", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const result = await serveShellRequest(router, "/ppr", {
      cacheStore,
      partial: true,
    });

    expect(result.replayStatus).toEqual({
      outcome: "BYPASS",
      reason: "no-entry",
    });
    const stored = await cacheStore.getShell(navigationShellKey(result.key));
    expect(stored?.entry.navigationOnly).toBe(true);
    expectVisitorEventsOnly();
  });

  it("a handle pushed late reports one handler.error, the visitor's", async () => {
    const result = await serveShellRequest(router, "/late-push", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(result.shellStatus).toBe("MISS");
    releaseLatePush();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const start = events.find((event) => event.type === "request.start")!;
    expect(eventIds()).toEqual([
      ["request.start", start.requestId],
      ["cache.decision", start.requestId],
      ["request.end", start.requestId],
      ["handler.error", start.requestId],
    ]);
  });
});
