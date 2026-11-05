/**
 * The segment a late push from a layout's or slot's ctx names, through
 * serveShellRequest's document and partial navigation.
 *
 * A layout and its parallel slot each hand their ctx to an async component
 * that pushes after an await. By then handle collection has completed, so
 * the push is rejected (LateHandlePushError, by design). Its message names
 * the segment whose ctx made it: each ctx pins handle pushes to its segment
 * (withSegmentPin, router/handler-context.ts). Read from the request's one
 * handler ctx, the pin had moved on to the route the walker resolved last.
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
  createRouter,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

const errors: string[] = [];

async function LatePush({
  ctx,
  label,
}: {
  ctx: HandlerContext;
  label: string;
}) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  ctx.use(Crumbs)(label);
  return <p>{label}</p>;
}

const router = createRouter({
  onError: ({ error }) => {
    errors.push(error instanceof Error ? error.message : String(error));
  },
}).routes(
  urls(({ path, layout, parallel }) => [
    path("/a", () => <p>a</p>, { name: "a" }),
    layout(
      (ctx: HandlerContext) => (
        <div>
          <LatePush ctx={ctx} label="layout" />
        </div>
      ),
      () => [
        path("/l", () => <p>page</p>, { name: "l" }),
        parallel({
          "@side": (ctx: HandlerContext) => (
            <aside>
              <LatePush ctx={ctx} label="side" />
            </aside>
          ),
        }),
      ],
    ),
  ]),
);

function lateSegments(): string[] {
  return errors.flatMap((message) => {
    const match = /^Handle "[^"]*" for segment "([^"]+)" was pushed after/.exec(
      message,
    );
    return match ? [match[1]!] : [];
  });
}

beforeEach(async () => {
  errors.length = 0;
  await resetShellTestState();
});

describe("a late push from a layout's ctx names the layout's segment", () => {
  for (const shape of ["document", "navigation"] as const) {
    it(shape, async () => {
      const result = await serveShellRequest(router, "/l", {
        cacheStore: new MemorySegmentCacheStore(),
        partial:
          shape === "document" ? undefined : { from: "/a", segments: [] },
      });
      await result.readHandles();
      await vi.waitFor(() => expect(lateSegments()).toHaveLength(2));
      expect(lateSegments().sort()).toEqual(["M0L0L0", "M0L0L0.@side"]);
    });
  }
});
