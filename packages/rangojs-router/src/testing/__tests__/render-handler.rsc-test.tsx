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
});
