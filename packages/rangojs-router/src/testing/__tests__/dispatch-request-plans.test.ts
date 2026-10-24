/**
 * dispatch classifies each pass with the production handler's classify stage
 * and answers its terminal plans inside the global middleware chain
 * (rsc/request-stages.ts), through the public testing entry a consumer uses.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

function pluginRscMock() {
  return {
    createFromReadableStream: vi.fn(),
    renderToReadableStream: vi.fn(),
    loadServerAction: vi.fn(),
    decodeReply: vi.fn(),
    decodeAction: vi.fn(),
    decodeFormState: vi.fn(),
    createTemporaryReferenceSet: vi.fn(),
  };
}
vi.mock("@vitejs/plugin-rsc/rsc/server", pluginRscMock);
vi.mock("@vitejs/plugin-rsc/rsc/client", pluginRscMock);

import { dispatch, setBuildVersions } from "../index.js";
import {
  createRouter,
  getRequestContext,
  rewrite,
  urls,
  type TelemetryEvent,
} from "../../index.rsc.js";

function Page() {
  return null;
}

afterEach(() => {
  setBuildVersions();
});

describe("dispatch reloads as production does", () => {
  it("reloads a navigation from a tab on another deploy at its URL, inside the global chain", async () => {
    let globalRan = false;
    const router = createRouter({})
      .use(async (_ctx, next) => {
        globalRan = true;
        return next();
      })
      .routes(urls(({ path }) => [path("/shop", Page, { name: "shop" })]));
    setBuildVersions({ data: "d2", document: "h2" });

    const res = await dispatch(router, {
      request: "/shop?_rsc_partial=true&_rsc_v=h1",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-rsc-reload")).toBe("http://localhost/shop");
    expect(globalRan).toBe(true);
  });

  it("reloads a navigation that crossed in from another app", async () => {
    const router = createRouter({ id: "shop-app" }).routes(
      urls(({ path }) => [path("/shop", Page, { name: "shop" })]),
    );

    const res = await dispatch(router, {
      request: "/shop?_rsc_partial=true&_rsc_rid=blog-app",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-rsc-reload")).toBe("http://localhost/shop");
  });
});

describe("dispatch sets the route's params where production does", () => {
  it("global middleware sees the route after next(), not before it", async () => {
    const seen: Array<{ at: string; routeName: unknown; params: unknown }> = [];
    const router = createRouter({})
      .use(async (ctx, next) => {
        seen.push({
          at: "before",
          routeName: ctx.routeName,
          params: { ...getRequestContext().params },
        });
        await next();
        seen.push({
          at: "after",
          routeName: ctx.routeName,
          params: { ...getRequestContext().params },
        });
      })
      .routes(
        urls(({ path }) => [
          path.json("/api/orders/:id", (ctx) => ({ id: ctx.params.id }), {
            name: "api.order",
          }),
        ]),
      );

    const res = await dispatch(router, { request: "/api/orders/7" });

    expect(await res.json()).toEqual({ id: "7" });
    expect(seen).toEqual([
      { at: "before", routeName: undefined, params: {} },
      { at: "after", routeName: "api.order", params: { id: "7" } },
    ]);
  });

  it("a trailing-slash redirect sets no route", async () => {
    const seen: unknown[] = [];
    const router = createRouter({})
      .use(async (ctx, next) => {
        await next();
        seen.push(ctx.routeName);
      })
      .routes(
        urls(({ path }) => [
          path.json("/api/orders/", () => ({ orders: [] }), {
            name: "api.orders",
            trailingSlash: "always",
          }),
        ]),
      );

    const res = await dispatch(router, { request: "/api/orders" });

    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/api/orders/");
    expect(seen).toEqual([undefined]);
  });
});

describe("dispatch keeps a rewritten action on a page route", () => {
  it("fails an action a global middleware moved to a response route, and never runs its handler", async () => {
    const handler = vi.fn(() => ({ moved: true }));
    const router = createRouter({})
      .use("/api/v1/orders", () => {
        throw rewrite("/api/v2/orders");
      })
      .routes(
        urls(({ path }) => [
          path.json("/api/v1/orders", () => ({ v1: true })),
          path.json("/api/v2/orders", handler),
        ]),
      );

    await expect(
      dispatch(router, {
        request: new Request(
          "http://localhost/api/v1/orders?_rsc_action=orders%23save",
          { method: "POST" },
        ),
      }),
    ).rejects.toThrow(
      "A rewrite of a server action or form post must target a page route; /api/v2/orders is a response route.",
    );
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("dispatch telemetry on a rewritten pass", () => {
  it("a response-route timeout after a rewrite carries the request's own requestId", async () => {
    const events: TelemetryEvent[] = [];
    const router = createRouter({
      timeouts: { renderStartMs: 5 },
      telemetry: { emit: (event) => events.push(event) },
    })
      .use("/api/report", () => {
        throw rewrite("/api/slow");
      })
      .routes(
        urls(({ path }) => [
          path.json("/api/report", () => ({ report: true })),
          path.json("/api/slow", async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { tooLate: true };
          }),
        ]),
      );

    const res = await dispatch(router, { request: "/api/report" });

    expect(res.status).toBe(504);
    expect(res.headers.get("x-rango-rewrite")).toBe("/api/slow");
    expect(events.map((event) => event.type)).toEqual([
      "request.start",
      "request.timeout",
      "request.end",
    ]);
    const [start, timeout, end] = events as Array<{ requestId?: string }>;
    expect(start!.requestId).toBeDefined();
    expect(timeout!.requestId).toBe(start!.requestId);
    expect(end!.requestId).toBe(start!.requestId);
  });
});
