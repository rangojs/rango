/**
 * A server action or a no-JS form post from a page that route middleware
 * reached through `throw rewrite()` (#1145), through the public testing
 * primitives (serveShellRequest, createActionForm).
 *
 * The POST goes to the visitor's URL, so it matches the rewriting route. Route
 * middleware wraps only the re-render after the action, so its rewrite fires
 * after the action ran: the re-render runs as the target (its global and route
 * middleware, its render), and the action is not run again.
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

import {
  createActionForm,
  resetShellTestState,
  serveShellRequest,
} from "../flight.entry.js";
import {
  createLoader,
  createRouter,
  createVar,
  rewrite,
  urls,
  type HandlerContext,
  type OnErrorContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";

const Guard = createVar<string>();

let actionRuns = 0;
let targetGlobalRuns = 0;
let itemLoaderFails = false;
const errors: OnErrorContext[] = [];

const ItemLoader = createLoader(async (ctx) => {
  if (itemLoaderFails) throw new Error("item service unavailable");
  return { item: String(ctx.params.id), runs: actionRuns };
});

async function save(): Promise<string> {
  actionRuns++;
  return "saved";
}

async function saveForm(_prev: unknown, _form: FormData): Promise<string> {
  actionRuns++;
  return "saved";
}

async function failingSave(): Promise<string> {
  actionRuns++;
  throw new Error("save failed");
}

const router = createRouter({
  onError: (context) => {
    errors.push(context);
  },
})
  .use(async (ctx, next) => {
    // A lock in global middleware fires before the action: still refused.
    if (ctx.searchParams.get("lock") === "naive") throw rewrite("/item/0");
    return next();
  })
  .use(async (ctx, next) => {
    // A form-field CSRF check on every pass: it reads a clone of the body.
    const type = ctx.request.headers.get("content-type") ?? "";
    if (ctx.request.method === "POST" && type.startsWith("multipart/")) {
      const form = await ctx.request.clone().formData();
      if (form.get("csrf") !== "ok") {
        return new Response("Bad CSRF token", { status: 403 });
      }
    }
    return next();
  })
  .use("/item/*", async (ctx, next) => {
    targetGlobalRuns++;
    if (ctx.request.headers.get("x-deny") === "1") {
      return new Response("Denied", { status: 403 });
    }
    return next();
  })
  .routes(
    urls(({ path, middleware, loader, errorBoundary }) => [
      path("/", () => <main>home</main>, { name: "home" }),
      path.json("/api/item", () => ({ api: true }), { name: "apiItem" }),
      // A rewriting route with no boundary of its own.
      path(
        "/bare/:id",
        () => <main>bare</main>,
        { name: "bare" },
        () => [
          middleware((ctx) => {
            throw rewrite(`/item/${ctx.params.id}`);
          }),
        ],
      ),
      path(
        "/to-api",
        () => <main>to api</main>,
        { name: "toApi" },
        () => [
          middleware(() => {
            throw rewrite("/api/item");
          }),
        ],
      ),
      path(
        "/item/:id",
        (ctx: HandlerContext<{ id: string }>) => (
          <main>{`item ${String(ctx.params.id)} guard=${ctx.get(Guard)} runs=${actionRuns}`}</main>
        ),
        { name: "item" },
        () => [
          middleware(async (ctx, next) => {
            ctx.set(Guard, "target");
            await next();
          }),
          loader(ItemLoader),
          errorBoundary(() => <p>item boundary</p>),
        ],
      ),
      path(
        "/*",
        () => <main>fallback</main>,
        { name: "fallback" },
        () => [
          middleware((ctx, next) => {
            // A routing rewrite: every method, as the middleware skill says.
            if (ctx.pathname.startsWith("/public-")) {
              throw rewrite(
                `/item/${ctx.pathname.slice("/public-".length)}${ctx.url.search}`,
              );
            }
            return next();
          }),
          errorBoundary(() => <p>fallback boundary</p>),
        ],
      ),
    ]),
  );

const CSRF = { csrf: "ok" };

type Metadata = { routeName: string; matched: string[]; pathname: string };

function metadata(flight: string | undefined): Metadata {
  const row = flight?.split("\n").find((line) => line.startsWith("0:"));
  expect(row).toBeDefined();
  return (JSON.parse(row!.slice(2)) as { metadata: Metadata }).metadata;
}

async function showPage(
  url: string,
  cacheStore: MemorySegmentCacheStore,
): Promise<Metadata> {
  const page = await serveShellRequest(router, url, {
    cacheStore,
    partial: { from: "/" },
  });
  const shown = metadata(page.flight);
  expect(shown.routeName).toBe("item");
  return shown;
}

beforeEach(() => {
  resetShellTestState();
  actionRuns = 0;
  targetGlobalRuns = 0;
  itemLoaderFails = false;
  errors.length = 0;
});

describe("a JS action from a page route middleware rewrote", () => {
  it("re-renders the page it shows and runs the action once", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const shown = await showPage("/public-1", cacheStore);
    targetGlobalRuns = 0;

    const result = await serveShellRequest(router, "/public-1", {
      cacheStore,
      action: { ref: save, id: "actions.ts#save", segments: shown.matched },
    });

    expect(actionRuns).toBe(1);
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("x-rango-rewrite")).toBe("/item/1");
    const revalidated = metadata(result.flight);
    expect(revalidated.routeName).toBe("item");
    expect(revalidated.matched).toEqual(shown.matched);
    expect(revalidated.pathname).toBe("/public-1");
    // The target's route middleware and render ran after the action.
    expect(result.flight).toContain("item 1 guard=target runs=1");
    expect(result.flight).not.toContain("fallback");
    // The target's global middleware ran on the re-render.
    expect(targetGlobalRuns).toBe(1);
    expect(errors).toEqual([]);
  });

  it("matches a direct action at the target's URL", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const shown = await showPage("/item/1", cacheStore);
    const result = await serveShellRequest(router, "/item/1", {
      cacheStore,
      action: {
        ref: save,
        id: "actions.ts#saveDirect",
        segments: shown.matched,
      },
    });
    expect(actionRuns).toBe(1);
    const revalidated = metadata(result.flight);
    expect(revalidated.routeName).toBe("item");
    expect(revalidated.matched).toEqual(shown.matched);
  });

  it("resolves with the action's result when the target's loader throws on its rerun", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const shown = await showPage("/public-1", cacheStore);
    itemLoaderFails = true;
    const result = await serveShellRequest(router, "/public-1", {
      cacheStore,
      action: {
        ref: save,
        id: "actions.ts#saveLoaderFails",
        segments: shown.matched,
      },
    });
    expect(actionRuns).toBe(1);
    expect(result.response.status).toBe(200);
    expect(metadata(result.flight).routeName).toBe("item");
    expect(await result.readAction()).toEqual({
      ok: true,
      result: "saved",
      revalidationError: expect.objectContaining({
        message: "An error occurred",
      }),
    });
    expect(errors.map((e) => [e.phase, (e.error as Error).message])).toEqual([
      ["loader", "item service unavailable"],
    ]);
  });

  it("runs the target's guards on the re-render", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const shown = await showPage("/public-1", cacheStore);
    const result = await serveShellRequest(router, "/public-1", {
      cacheStore,
      headers: { "x-deny": "1" },
      action: {
        ref: save,
        id: "actions.ts#saveDenied",
        segments: shown.matched,
      },
    });
    // Route middleware never guarded the action itself; the re-render is.
    expect(actionRuns).toBe(1);
    expect(result.response.status).toBe(403);
    expect(result.body).toBe("Denied");
  });

  it("renders the target's error boundary when the action throws", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const shown = await showPage("/public-1", cacheStore);
    const result = await serveShellRequest(router, "/public-1", {
      cacheStore,
      action: {
        ref: failingSave,
        id: "actions.ts#failingSave",
        segments: shown.matched,
      },
    });
    expect(actionRuns).toBe(1);
    expect(result.response.status).toBe(500);
    expect(result.flight).toContain("item boundary");
    expect(result.flight).not.toContain("fallback boundary");
    expect(errors.map((e) => e.phase)).toEqual(["action"]);
  });

  it("renders the target's error boundary when the rewriting route has none", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const shown = await showPage("/bare/3", cacheStore);
    const result = await serveShellRequest(router, "/bare/3", {
      cacheStore,
      action: {
        ref: failingSave,
        id: "actions.ts#failingSaveBare",
        segments: shown.matched,
      },
    });
    expect(actionRuns).toBe(1);
    expect(result.response.status).toBe(500);
    expect(result.flight).toContain("item boundary");
  });

  it("a rewrite to a response route fails with the rule and does not run its handler as a mutation", async () => {
    await expect(
      serveShellRequest(router, "/to-api", {
        cacheStore: new MemorySegmentCacheStore(),
        action: { ref: save, id: "actions.ts#saveToApi" },
      }),
    ).rejects.toThrow(
      "A rewrite after a server action or form post must target a page route; /api/item is a response route.",
    );
    expect(actionRuns).toBe(1);
  });

  it("a rewrite in global middleware is still refused before the action runs", async () => {
    await expect(
      serveShellRequest(router, "/public-1?lock=naive", {
        cacheStore: new MemorySegmentCacheStore(),
        action: { ref: save, id: "actions.ts#saveLocked" },
      }),
    ).rejects.toThrow(
      'rewrite("/item/0") is not supported here: middleware threw it while handling a non-GET request',
    );
    expect(actionRuns).toBe(0);
  });
});

describe("a no-JS form post from a page route middleware rewrote", () => {
  it("re-renders the page it shows and runs the action once", async () => {
    const page = await serveShellRequest(router, "/public-2", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    const result = await serveShellRequest(router, "/public-2", {
      cacheStore: new MemorySegmentCacheStore(),
      form: createActionForm(saveForm, {
        id: "actions.ts#saveForm",
        fields: CSRF,
      }),
    });
    expect(actionRuns).toBe(1);
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("x-rango-rewrite")).toBe("/item/2");
    expect(result.body).toContain("item 2 guard=target runs=1");
    expect(result.body).not.toContain("fallback");
    const rerendered = metadata(result.flight);
    expect(rerendered.matched).toEqual(metadata(page.flight).matched);
    expect(rerendered.pathname).toBe("/public-2");
    expect(result.formState).toBeDefined();
    expect(errors).toEqual([]);
  });

  it("runs the target's guards on the re-render", async () => {
    const result = await serveShellRequest(router, "/public-2", {
      cacheStore: new MemorySegmentCacheStore(),
      headers: { "x-deny": "1" },
      form: createActionForm(saveForm, {
        id: "actions.ts#saveFormDenied",
        fields: CSRF,
      }),
    });
    expect(actionRuns).toBe(1);
    expect(result.response.status).toBe(403);
    expect(result.body).toBe("Denied");
  });

  it("a rewrite in global middleware is still refused before the action runs", async () => {
    await expect(
      serveShellRequest(router, "/public-2?lock=naive", {
        cacheStore: new MemorySegmentCacheStore(),
        form: createActionForm(saveForm, {
          id: "actions.ts#saveFormLocked",
          fields: CSRF,
        }),
      }),
    ).rejects.toThrow("Return a Response for mutations instead");
    expect(actionRuns).toBe(0);
  });
});
