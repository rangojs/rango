// renderHandler: run a REAL route handler (a pure function `(ctx) => rsc`, what
// you pass to path(...)) with a seeded HandlerContext, then assert the RSC it
// renders + the effects it produced. Runs in the rsc project (react-server).
import { describe, expect, test } from "vitest";
import { findClientBoundaries, renderHandler } from "../flight.entry.js";
import { createVar } from "../../context-var.js";
import { createLoader } from "../../loader.js";
import { Meta } from "../../handles/meta.js";
import { redirect } from "../../route-definition/redirect.js";
import { Counter } from "./fixtures/Counter.js";
import type { HandlerContext } from "../../types/handler-context.js";

const Tenant = createVar<{ name: string }>();
const ProductLoader = createLoader(async () => ({ name: "Wine", price: 9 }));

describe("renderHandler", () => {
  test("runs a real handler: params + ctx.use(Loader) + ctx.get + renders RSC", async () => {
    // The handler is a pure function (ctx) => rsc — exactly as authored for path().
    async function ProductPage(ctx: HandlerContext<{ slug: string }>) {
      const product = await ctx.use(ProductLoader);
      const tenant = ctx.get(Tenant);
      return (
        <main>
          <h1>
            {tenant?.name}: {product.name}
          </h1>
          <p>slug: {ctx.params.slug}</p>
          <span>${product.price}</span>
        </main>
      );
    }

    const { tree, flight } = await renderHandler(ProductPage, {
      params: { slug: "wine" },
      loaders: [[ProductLoader, { name: "Wine", price: 9 }]],
      vars: [[Tenant, { name: "Acme" }]],
    });

    expect(flight).toBeDefined();
    const json = JSON.stringify(tree);
    expect(json).toContain("Acme");
    expect(json).toContain("Wine");
    expect(json).toContain("wine"); // the slug param
    expect(json).toContain("9");
  });

  test("captures handle pushes (ctx.use(Meta)) without crashing", async () => {
    function Page(ctx: HandlerContext) {
      const meta = ctx.use(Meta);
      meta({ title: "Product - Shop" });
      return <main>ok</main>;
    }
    const { handles, tree } = await renderHandler(Page);
    expect(JSON.stringify(tree)).toContain("ok");
    expect(handles.get(Meta)).toEqual([{ title: "Product - Shop" }]);
  });

  test("a handler's client island crosses the boundary and props are typed", async () => {
    function Page(ctx: HandlerContext<{ start: string }>) {
      return (
        <main>
          <Counter
            start={Number(ctx.params.start)}
            when={new Date(0)}
            tags={new Map()}
          />
        </main>
      );
    }
    const { tree } = await renderHandler(Page, {
      params: { start: "7" },
      clientComponents: { Counter },
    });
    const [counter] = findClientBoundaries(tree, "Counter");
    expect(counter.props.start).toBe(7);
    expect(counter.props.when).toBeInstanceOf(Date);
  });

  test("a handler that sets a header/flash then redirects: effects + thrown", async () => {
    function LoginAction(ctx: HandlerContext): never {
      ctx.headers.set("X-Auth", "ok");
      ctx.setLocationState([
        { __rsc_ls_key: "flash", __rsc_ls_value: { text: "Welcome" } },
      ]);
      throw redirect("/app");
    }
    const { thrown, tree, response, headers, locationState } =
      await renderHandler(LoginAction);

    expect(tree).toBeUndefined(); // returned a Response, not RSC
    expect(thrown).toBeInstanceOf(Response);
    expect(response.headers.get("Location")).toBe("/app");
    expect(headers.location).toBe("/app");
    expect(headers["x-auth"]).toBe("ok");
    expect(locationState).toEqual({ flash: { text: "Welcome" } });
  });

  test("an unseeded ctx.use(loader) throws a helpful error", async () => {
    function Page(ctx: HandlerContext) {
      ctx.use(ProductLoader); // not seeded
      return <main />;
    }
    await expect(renderHandler(Page)).rejects.toThrow(/was not seeded/i);
  });

  test("rethrows an actionable error when the handler hits the server-only stub (missing rsc alias)", async () => {
    // Simulate the out-of-react-server stub throw a handler would hit if the
    // vitest.rsc.config.ts resolve.alias does not map bare @rangojs/router to
    // index.rsc.ts. renderHandler must surface it LOUDLY (not swallow it into
    // result.thrown as an opaque tree:undefined).
    function Page(): never {
      throw new Error(
        `cookies() is only available from "@rangojs/router" in a react-server/RSC environment.`,
      );
    }
    await expect(renderHandler(Page)).rejects.toThrow(/rangoTestAliases/);
  });

  test("a normal handler throw is captured on result.thrown, NOT reclassified as setup", async () => {
    // Control: an ordinary Error must stay observable on result.thrown (no
    // false-positive from the server-only-stub guard).
    const boom = new Error("boom from handler");
    function Page(): never {
      throw boom;
    }
    const { thrown, tree } = await renderHandler(Page);
    expect(thrown).toBe(boom);
    expect(tree).toBeUndefined();
  });

  test("a handler that RETURNS a Response preserves its body (response route)", async () => {
    // The documented response-route case: a handler returns
    // `new Response(JSON.stringify(...))`. Pre-fix buildResponse rewrapped to
    // `new Response(null, ...)` and the body was lost; now it is carried over so
    // `await result.response.text()`/`.json()` works.
    function Health(): Response {
      return new Response(JSON.stringify({ ok: true, count: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const { tree, response } = await renderHandler(Health);
    expect(tree).toBeUndefined(); // a Response, not RSC
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe('{"ok":true,"count":2}');
  });

  test("a returned Response body survives alongside a handler-set cookie", async () => {
    // The stub-cookie merge must not clobber the carried-over body.
    function Page(ctx: HandlerContext): Response {
      ctx.headers.set("X-Trace", "abc");
      return new Response("plain body", {
        status: 201,
        headers: { "content-type": "text/plain" },
      });
    }
    const { response, headers } = await renderHandler(Page);
    expect(response.status).toBe(201);
    expect(headers["x-trace"]).toBe("abc");
    expect(await response.text()).toBe("plain body");
  });

  test("ctx.use(Handle)(() => value) records the EVALUATED value, not the function", async () => {
    // Production's push fn CALLS a function argument and pushes its RESULT
    // (loader-resolution.ts). The harness must mirror it, so the function form
    // (the typed signature is `() => Promise<...>`) yields the awaited value in
    // result.handles, not a raw `[Function]`. Pre-fix the function itself was
    // recorded.
    function Page(ctx: HandlerContext) {
      const meta = ctx.use(Meta);
      meta(async () => ({ title: "Computed Title" }));
      return <main>ok</main>;
    }
    const { handles } = await renderHandler(Page);
    const [pushed] = handles.get(Meta) ?? [];
    // The fix: the callback was invoked. Pre-fix `pushed` would be the function.
    expect(typeof pushed).not.toBe("function");
    expect(pushed).toBeInstanceOf(Promise); // an async callback records its promise
    expect(await pushed).toEqual({ title: "Computed Title" });
  });

  test("throws a migration error for the legacy { request -> url } rename", async () => {
    // { url } was renamed to { request }. A plain-JS / spread-defeated consumer
    // still passing it would otherwise render against the default origin.
    function Page() {
      return <main />;
    }
    await expect(
      // @ts-expect-error legacy option removed; runtime guard catches it.
      renderHandler(Page, { url: "/legacy" }),
    ).rejects.toThrow(/`url` option was renamed to `request`/);
  });
});
