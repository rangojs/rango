/**
 * The segment a late handle push names, through serveShellRequest: an async
 * component a layout, slot, route or intercept handler handed its ctx to
 * pushes after the walker has resolved the segments below it. The push is
 * still rejected (LateHandlePushError), and the message must name the segment
 * that owns the ctx the component was handed, not whichever segment the
 * walker had moved the shared `_currentSegmentId` pin to by then.
 *
 * The error reaches the test through the telemetry sink (handler.error), the
 * raw Error the store reports before throwing it; the served payload's message
 * is sanitized under NODE_ENV=production, which this project forces.
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
import { createHandle, createRouter, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import type { Handler } from "../../types.js";
import type { TelemetryEvent } from "../../router/telemetry.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

type Ctx = Parameters<Handler>[0];

/** Pushes `label` after an await, with the ctx its handler was handed. */
async function LatePush({
  ctx,
  label,
}: {
  ctx: Ctx;
  label: string;
}): Promise<React.ReactNode> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  ctx.use(Crumbs)(label);
  return <p>{label}</p>;
}

/** The raw error each late push reports before the store throws it. */
function latePushSink(errors: Error[]): {
  emit(event: TelemetryEvent): void;
} {
  return {
    emit(event) {
      if (event.type === "handler.error") errors.push(event.error as Error);
    },
  };
}

/** The segment id each reported late push named. */
function namedSegments(errors: Error[]): string[] {
  return errors.map(
    (error) =>
      /for segment "([^"]+)" was pushed after/.exec(error.message)![1]!,
  );
}

async function serve(
  router: Parameters<typeof serveShellRequest>[0],
  url: string,
  options: Parameters<typeof serveShellRequest>[2] = {},
): Promise<void> {
  try {
    await serveShellRequest(router, url, options);
  } catch {
    // A dev render error can reject the response; the sink reported the
    // error either way.
  }
}

beforeEach(async () => {
  await resetShellTestState();
});

describe("a component's late handle push through a handler's ctx", () => {
  it("names the layout's segment, not the route's below it", async () => {
    const errors: Error[] = [];
    const router = createRouter({ telemetry: latePushSink(errors) }).routes(
      urls(({ layout, path }) => [
        layout(
          (ctx: Ctx) => (
            <main>
              <LatePush ctx={ctx} label="layout" />
            </main>
          ),
          () => [path("/late", () => <p>page</p>, { name: "late" })],
        ),
      ]),
    );
    await serve(router, "/late");
    expect(namedSegments(errors)).toEqual(["M0L0L0"]);
  });

  it("names the route's segment", async () => {
    const errors: Error[] = [];
    const router = createRouter({ telemetry: latePushSink(errors) }).routes(
      urls(({ path }) => [
        path(
          "/late-route",
          (ctx: Ctx) => <LatePush ctx={ctx} label="route" />,
          { name: "lateRoute" },
        ),
      ]),
    );
    await serve(router, "/late-route");
    expect(namedSegments(errors)).toEqual(["M0L0R0"]);
  });

  it("names the slot's segment, not the route's after it", async () => {
    const errors: Error[] = [];
    const router = createRouter({ telemetry: latePushSink(errors) }).routes(
      urls(({ layout, parallel, path }) => [
        layout(
          () => <main>shell</main>,
          () => [
            parallel({
              "@side": (ctx: Ctx) => <LatePush ctx={ctx} label="side" />,
            }),
            path("/late-slot", () => <p>page</p>, { name: "lateSlot" }),
          ],
        ),
      ]),
    );
    await serve(router, "/late-slot");
    expect(namedSegments(errors)).toEqual(["M0L0L0.@side"]);
  });

  it("names the route's segment, not its own slot's that ran after it", async () => {
    const errors: Error[] = [];
    const router = createRouter({ telemetry: latePushSink(errors) }).routes(
      urls(({ path, parallel }) => [
        path(
          "/late-route-slot",
          (ctx: Ctx) => <LatePush ctx={ctx} label="route" />,
          { name: "lateRouteSlot" },
          () => [
            // Runs after the route handler returned and moves the shared pin;
            // the route's component must still name the route.
            parallel({ "@side": () => <aside>side</aside> }),
          ],
        ),
      ]),
    );
    await serve(router, "/late-route-slot");
    expect(namedSegments(errors)).toEqual(["M0L0R0"]);
  });

  it("names the intercept's segment, not the target route's", async () => {
    const errors: Error[] = [];
    const router = createRouter({ telemetry: latePushSink(errors) }).routes(
      urls(({ layout, intercept, path }) => [
        layout(
          () => <main>shell</main>,
          () => [
            path("/list", () => <ul>list</ul>, { name: "list" }),
            path("/item/:id", () => <article>item</article>, { name: "item" }),
            intercept("@modal", ".item", (ctx: Ctx) => (
              <LatePush ctx={ctx} label="modal" />
            )),
          ],
        ),
      ]),
    );
    const cacheStore = new MemorySegmentCacheStore();
    const list = await serveShellRequest(router, "/list", {
      cacheStore,
      partial: true,
    });
    const { metadata } = await deserializeResult<{
      metadata: { matched: string[] };
    }>(list.flight!);
    await serve(router, "/item/1", {
      cacheStore,
      partial: { from: "/list", segments: metadata.matched },
    });
    expect(namedSegments(errors)).toEqual(["M0L0L0.@modal"]);
  });
});
