/**
 * The segment a LateHandlePushError names for a push an async component makes
 * after an `await`, with the ctx a handler handed it.
 *
 * A layout handler returns its element and the walker pins the next segment;
 * React renders the layout's async component after that, so `ctx.use(Handle)`
 * there reads a pin that has moved on. The ctx a segment's handler is handed
 * carries the segment it ran for (handler-context.ts withSegmentScope), so the
 * message names the layout, not the route under it. A route handler's ctx is
 * the request's own, whose pin is the route's while it renders.
 *
 * Read through serveShellRequest: the document's handle collection completes
 * at the render barrier, before the async component resumes.
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

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

/** The error the late push threw, captured so the render can finish. */
let latePush: Error | undefined;

/** A component the handler hands its ctx to; it pushes after an await. */
async function LatePush({ ctx, label }: { ctx: any; label: string }) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  try {
    ctx.use(Crumbs)(label);
  } catch (error) {
    latePush = error as Error;
  }
  return <p>{label}</p>;
}

/** `/layout` hands the layout handler's ctx on, `/route` the route's. */
function handOff() {
  return createRouter({}).routes(
    urls(({ path, layout }) => [
      layout(
        (ctx) => <main>{<LatePush ctx={ctx} label="layout" />}</main>,
        () => [
          path("/route", (ctx) => <LatePush ctx={ctx} label="route" />, {
            name: "route",
          }),
          path("/layout", () => <article>layout</article>, { name: "layout" }),
        ],
      ),
    ]),
  );
}

async function serve(url: string): Promise<void> {
  await serveShellRequest(handOff(), url, {
    cacheStore: new MemorySegmentCacheStore(),
  });
}

beforeEach(async () => {
  latePush = undefined;
  await resetShellTestState();
});

describe("a late push through the ctx a handler handed on", () => {
  it("names the layout's segment, not the route's under it", async () => {
    await serve("/layout");
    expect(latePush?.name).toBe("LateHandlePushError");
    expect(latePush?.message).toMatch(/for segment "\w*L\d+" was pushed after/);
  });

  it("control: names the route's segment for a route handler's ctx", async () => {
    await serve("/route");
    expect(latePush?.name).toBe("LateHandlePushError");
    expect(latePush?.message).toMatch(/for segment "\w*R\d+" was pushed after/);
  });
});
