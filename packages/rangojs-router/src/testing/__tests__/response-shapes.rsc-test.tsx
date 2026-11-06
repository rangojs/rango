import { describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import type { ServeShellRequestResult } from "../flight.entry.js";
import {
  createHandle,
  createRouter,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import {
  expectNoInternalFields,
  internalFieldsIn,
  serveEveryShape,
} from "./helpers/response-shapes.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

function Root(ctx: HandlerContext): React.ReactNode {
  ctx.use(Crumbs)("root");
  return <main>root</main>;
}

/** A list whose items open in an intercept, under a cache(). */
const modalRouter = createRouter({}).routes(
  urls(({ path, layout, cache, intercept }) => [
    cache({ ttl: 600 }, () => [
      layout(Root, () => [
        path("/list", () => <ul>list</ul>, { name: "list" }),
        path("/item/:id", () => <article>item</article>, { name: "item" }),
        intercept("@modal", ".item", (ctx: HandlerContext<{ id: string }>) => {
          ctx.use(Crumbs)(`modal-${ctx.params.id}`);
          return <dialog>modal</dialog>;
        }),
      ]),
    ]),
  ]),
);

describe("serveEveryShape", () => {
  it("serves the documents, the partial and the open intercept, each MISS then HIT", async () => {
    const shapes = await serveEveryShape(modalRouter, {
      from: "/list",
      to: "/item/1",
      intercept: { next: "/item/2" },
    });
    expect(shapes.map((s) => s.name)).toEqual([
      "document from MISS",
      "document from HIT",
      "document to MISS",
      "document to HIT",
      "partial MISS",
      "partial HIT",
      "intercept opened MISS",
      "intercept opened HIT",
      "intercept moved MISS",
      "intercept moved HIT",
    ]);
    for (const { name, result } of shapes) {
      expect(result.response.status, name).toBe(200);
      expect(result.flight, name).toBeTruthy();
    }
    expect(
      shapes.find((s) => s.name === "intercept moved HIT")!.result.flight,
    ).toContain("modal");
    expectNoInternalFields(shapes);
  });
});

describe("internalFieldsIn", () => {
  it("finds _-prefixed keys and nothing else", () => {
    expect(
      internalFieldsIn('0:{"_handlerRan":true,"id":"a","$_ref":1,"x_y":2}'),
    ).toEqual(["_handlerRan"]);
  });
});

describe("expectNoInternalFields", () => {
  it("fails naming the shape and the field", () => {
    const leaked = {
      name: "intercept moved HIT",
      result: {
        flight: '0:{"slots":{"@modal":{"_handlerRan":true}}}',
      } as ServeShellRequestResult,
    };
    expect(() => expectNoInternalFields([leaked])).toThrow(
      /intercept moved HIT[\s\S]*_handlerRan/,
    );
  });
});
