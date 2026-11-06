/**
 * The segment a LateHandlePushError names when an async server component the
 * handler handed its ctx to pushes after an `await`, through
 * serveShellRequest.
 *
 * The push is rejected by design (the `.defer()` path is the mitigation), so
 * the message is all a consumer sees of it: it must name the segment whose
 * ctx made the push, not whichever segment the walker pinned last. A layout
 * handler's ctx carries its own segment, so the message names the layout,
 * however the handler hands `use` on: the ctx itself, the function detached
 * (`const { use } = ctx`) or a `{ ...ctx }` copy.
 *
 * A route handler's ctx is the request's one ctx (its `{ ...ctx }` copy is a
 * route-wide contract), so its push reads the shared pin: the route's only
 * while nothing pins after it. A route with a parallel slot names the slot.
 * That is not what this change fixes and no test here pins it.
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
import { deserializeResult } from "../../cache/segment-codec.js";
import { callShapes } from "./helpers/call-shapes.js";
import { serveEveryShape } from "./helpers/response-shapes.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

const errors: string[] = [];

/** An async server component pushing the ctx its handler handed it. */
async function LatePush({
  ctx,
  label,
}: {
  ctx: HandlerContext;
  label: string;
}) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  ctx.use(Crumbs)(label);
  return <span>{label}</span>;
}

/**
 * An async server component pushing through one call shape of `ctx.use`,
 * taken after its own `await` as a component does.
 */
async function LateShapePush({
  shape,
  label,
}: {
  shape: ReturnType<typeof callShapes<HandlerContext>>[number];
  label: string;
}) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const push = (await shape.call(Crumbs)) as (value: string) => void;
  push(label);
  return <span>{label}</span>;
}

function makeRouter() {
  return createRouter({
    onError: ({ error }) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  }).routes(
    urls(({ path, layout, parallel }) => [
      layout(
        () => <main>shell</main>,
        () => [
          layout(
            (ctx) => (
              <div>
                <LatePush ctx={ctx} label="layout" />
              </div>
            ),
            () => [
              path("/component-layout", () => <p>page</p>, {
                name: "componentLayout",
              }),
            ],
          ),
          layout(
            () => <section>slot frame</section>,
            () => [
              parallel({
                "@panel": (ctx) => <LatePush ctx={ctx} label="slot" />,
              }),
              path("/component-slot", () => <p>page</p>, {
                name: "componentSlot",
              }),
            ],
          ),
          path("/component", (ctx) => <LatePush ctx={ctx} label="route" />, {
            name: "component",
          }),
        ],
      ),
    ]),
  );
}

/**
 * A layout and a parallel slot that hand every call shape of their `ctx.use`
 * to a component: the ctx as a method, the function detached, a `{ ...ctx }`
 * copy.
 */
function makeShapeRouter() {
  const shapes = (label: string) => (ctx: HandlerContext) => (
    <div>
      {callShapes(ctx, "use").map((shape) => (
        <LateShapePush
          key={shape.name}
          shape={shape}
          label={`${label}:${shape.name}`}
        />
      ))}
    </div>
  );
  return createRouter({
    onError: ({ error }) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  }).routes(
    urls(({ path, layout, parallel }) => [
      layout(
        () => <main>shell</main>,
        () => [
          layout(shapes("layout"), () => [
            path("/shapes-layout", () => <p>page</p>, { name: "shapesLayout" }),
          ]),
          layout(
            () => <section>slot frame</section>,
            () => [
              parallel({ "@panel": shapes("slot") }),
              path("/shapes-slot", () => <p>page</p>, { name: "shapesSlot" }),
            ],
          ),
        ],
      ),
    ]),
  );
}

/** The segment ids the response's tree matched. */
async function matchedOf(flight: string | undefined): Promise<string[]> {
  const { metadata } = await deserializeResult<{
    metadata: { matched: string[] };
  }>(flight!);
  return metadata.matched;
}

async function serve(
  url: string,
  router: Parameters<typeof serveShellRequest>[0] = makeRouter(),
) {
  errors.length = 0;
  const result = await serveShellRequest(router, url, {
    cacheStore: new MemorySegmentCacheStore(),
  });
  return { errors: [...errors], matched: await matchedOf(result.flight) };
}

/** Every segment the reported LateHandlePushErrors name. */
function latePushSegments(reported: string[]): string[] {
  return reported.map((message) => {
    const segment = /for segment "([^"]+)" was pushed after/.exec(message);
    // A shape that threw before pushing (a copy carrying no `use`) reports
    // its own message: keep it so the assertion shows which shape failed.
    return segment ? segment[1]! : message;
  });
}

beforeEach(async () => {
  await resetShellTestState();
});

describe("a LateHandlePushError names the segment whose ctx pushed", () => {
  it("the layout's, for a component the layout handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/component-layout");
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegments(reported)).toEqual([layout]);
  });

  it("the slot's, for a component the parallel slot's handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/component-slot");
    const slot = matched.find((id) => id.endsWith(".@panel"))!;
    expect(latePushSegments(reported)).toEqual([slot]);
  });

  it("the route's, for a component the route handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/component");
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(latePushSegments(reported)).toEqual([route]);
  });

  for (const kind of [
    { label: "layout", url: "/shapes-layout", id: /L\d+$/ },
    { label: "slot", url: "/shapes-slot", id: /\.@panel$/ },
  ]) {
    it(`the ${kind.label}'s, for every call shape of \`use\` it handed on`, async () => {
      const { errors: reported, matched } = await serve(
        kind.url,
        makeShapeRouter(),
      );
      const segment = matched.filter((id) => kind.id.test(id)).at(-1)!;
      // Six shapes: method, detached, spread, spread detached, and both
      // after an await. A shape that files under another segment, or throws
      // because the copy carries no `use`, leaves fewer than six here.
      expect(latePushSegments(reported)).toEqual(Array(6).fill(segment));
    });
  }
});

describe("every served shape names the layout's segment", () => {
  it("document and partial, MISS and HIT", async () => {
    errors.length = 0;
    const shapes = await serveEveryShape(
      createRouter({
        onError: ({ error }) => {
          errors.push(error instanceof Error ? error.message : String(error));
        },
      }).routes(
        urls(({ path, cache, layout, intercept }) => [
          cache({ ttl: 600 }, () => [
            layout(
              (ctx) => (
                <main>
                  <LatePush ctx={ctx} label="layout" />
                </main>
              ),
              () => [
                path("/list", () => <ul>list</ul>, { name: "list" }),
                path("/item/:id", () => <article>item</article>, {
                  name: "item",
                }),
                intercept("@modal", ".item", () => <dialog>modal</dialog>),
              ],
            ),
          ]),
        ]),
      ),
      { from: "/list", to: "/item/1", intercept: { next: "/item/2" } },
    );
    // Document from and to, partial, intercept opened and intercept moved:
    // each MISS and HIT.
    expect(shapes).toHaveLength(10);
    const matched = await matchedOf(shapes[0]!.result.flight);
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    // A HIT replays the cached layout without running its handler, so only
    // the MISS shapes push: five of the ten.
    expect(latePushSegments(errors).length).toBeGreaterThanOrEqual(5);
    expect(new Set(latePushSegments(errors))).toEqual(new Set([layout]));
  });
});
