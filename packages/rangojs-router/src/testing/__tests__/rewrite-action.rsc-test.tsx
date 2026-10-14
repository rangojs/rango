/**
 * A server action or a no-JS form post from a page that middleware reached
 * through `throw rewrite()` (#1145), through the public testing primitives
 * (serveShellRequest, createActionForm).
 *
 * The POST goes to the visitor's URL. Route middleware wraps only the
 * re-render after the action, so its rewrite fires after the action ran: the
 * re-render runs as the target (its global and route middleware, its render),
 * and the action is not run again. Route middleware sees that re-render as
 * the page's GET, so a rewrite it skips for mutations fires too. Global
 * middleware runs before the action, so its rewrite moves the mutation to the
 * target first, and the action runs on the target's pass;
 * `.disallowMutations()` refuses it there instead.
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
  getRequestContext,
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
/** The request the item's global and route middleware see, and the action. */
const seen: string[] = [];
/** The `note` field the form action read. */
let savedNote: FormDataEntryValue | null = null;

const ItemLoader = createLoader(async (ctx) => {
  if (itemLoaderFails) throw new Error("item service unavailable");
  return { item: String(ctx.params.id), runs: actionRuns };
});

async function save(): Promise<string> {
  actionRuns++;
  seen.push("action");
  return "saved";
}

async function saveForm(_prev: unknown, form: FormData): Promise<string> {
  actionRuns++;
  seen.push("action");
  savedNote = form.get("note");
  return "saved";
}

async function failingSave(): Promise<string> {
  actionRuns++;
  throw new Error("save failed");
}

async function failingSaveForm(
  _prev: unknown,
  _form: FormData,
): Promise<string> {
  actionRuns++;
  throw new Error("save failed");
}

/** The item's boundary: it reads what the item's route middleware set. */
function ItemBoundary() {
  return <p>{`item boundary guard=${getRequestContext().get(Guard)}`}</p>;
}

const router = createRouter({
  onError: (context) => {
    errors.push(context);
  },
})
  .use(async (ctx, next) => {
    // A lock in global middleware fires before the action: refused.
    if (ctx.searchParams.get("lock") === "strict") {
      throw rewrite("/item/0").disallowMutations();
    }
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
  .use(async (ctx, next) => {
    // A routing rewrite in global middleware: every method, or GET only.
    const every = /^\/global-(\d+)$/.exec(ctx.pathname);
    if (every) throw rewrite(`/item/${every[1]}`);
    const getOnly = /^\/global-get-(\d+)$/.exec(ctx.pathname);
    if (getOnly && ctx.request.method === "GET") {
      throw rewrite(`/item/${getOnly[1]}`);
    }
    // A global rewrite to a target that cannot run an action: a response
    // route, and a path that redirects (its trailing slash).
    if (ctx.pathname === "/global-api") throw rewrite("/api/item");
    const slash = /^\/global-slash-(\d+)$/.exec(ctx.pathname);
    if (slash) throw rewrite(`/item/${slash[1]}/`);
    // The same rewrite after reading the body itself (an audit log).
    const read = /^\/global-read-(\d+)$/.exec(ctx.pathname);
    if (read) {
      if (ctx.request.method === "POST") await ctx.request.text();
      throw rewrite(`/item/${read[1]}`);
    }
    // A lock that refuses mutations, alone or chained with .shell() either way.
    const lock = /^\/global-lock(-shell|-shell-first)?-(\d+)$/.exec(
      ctx.pathname,
    );
    if (lock) {
      const target = rewrite(`/item/${lock[2]}`);
      if (lock[1] === "-shell") {
        throw target.disallowMutations().shell("target");
      }
      if (lock[1] === "-shell-first") {
        throw target.shell("target").disallowMutations();
      }
      throw target.disallowMutations();
    }
    return next();
  })
  .use("/item/*", async (ctx, next) => {
    targetGlobalRuns++;
    seen.push(`global:${ctx.request.method}`);
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
        // `/item/1/` redirects to `/item/1`.
        { name: "item", trailingSlash: "never" },
        () => [
          middleware(async (ctx, next) => {
            seen.push(
              `route:${ctx.request.method}:${ctx.request.body ? "body" : "no-body"}`,
            );
            ctx.set(Guard, "target");
            await next();
            ctx.header("x-item-route-mw", "ran");
          }),
          loader(ItemLoader),
          errorBoundary(() => <ItemBoundary />),
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
            // The same rewrite, skipping mutations.
            if (ctx.pathname.startsWith("/skip-")) {
              if (ctx.request.method !== "GET") return next();
              throw rewrite(`/item/${ctx.pathname.slice("/skip-".length)}`);
            }
            // A lock in route middleware: it runs after the action.
            if (ctx.pathname.startsWith("/route-lock-")) {
              throw rewrite(
                `/item/${ctx.pathname.slice("/route-lock-".length)}`,
              ).disallowMutations();
            }
            return next();
          }),
          errorBoundary(() => <p>fallback boundary</p>),
        ],
      ),
    ]),
  );

const CSRF = { csrf: "ok" };

type Metadata = {
  routeName: string;
  matched: string[];
  pathname: string;
  rewriteTarget?: string;
};

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
  seen.length = 0;
  savedNote = null;
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
    expect(result.flight).toContain("item boundary guard=target");
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
      "A rewrite of a server action or form post must target a page route; /api/item is a response route.",
    );
    expect(actionRuns).toBe(1);
  });

  it("a lock in global middleware that disallows mutations is refused before the action runs", async () => {
    await expect(
      serveShellRequest(router, "/public-1?lock=strict", {
        cacheStore: new MemorySegmentCacheStore(),
        action: { ref: save, id: "actions.ts#saveLocked" },
      }),
    ).rejects.toThrow(
      'rewrite("/item/0") refused a mutation: .disallowMutations() was set',
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

  it("renders the target's error boundary inside its route middleware when the action throws", async () => {
    const result = await serveShellRequest(router, "/public-2", {
      cacheStore: new MemorySegmentCacheStore(),
      form: createActionForm(failingSaveForm, {
        id: "actions.ts#failingSaveForm",
        fields: CSRF,
      }),
    });
    expect(actionRuns).toBe(1);
    expect(result.response.status).toBe(500);
    expect(result.response.headers.get("x-rango-rewrite")).toBe("/item/2");
    expect(result.response.headers.get("x-item-route-mw")).toBe("ran");
    expect(result.body).toContain("item boundary guard=target");
    expect(result.body).not.toContain("fallback boundary");
    expect(metadata(result.flight).pathname).toBe("/public-2");
    expect(errors.map((e) => [e.phase, e.handledByBoundary])).toEqual([
      ["action", true],
    ]);
  });

  it("renders the target's error boundary when the rewriting route has none", async () => {
    const result = await serveShellRequest(router, "/bare/3", {
      cacheStore: new MemorySegmentCacheStore(),
      form: createActionForm(failingSaveForm, {
        id: "actions.ts#failingSaveFormBare",
        useActionState: false,
        fields: CSRF,
      }),
    });
    expect(actionRuns).toBe(1);
    expect(result.response.status).toBe(500);
    expect(result.body).toContain("item boundary guard=target");
  });

  it("renders a direct post's error boundary inside its route middleware", async () => {
    const result = await serveShellRequest(router, "/item/4", {
      cacheStore: new MemorySegmentCacheStore(),
      form: createActionForm(failingSaveForm, {
        id: "actions.ts#failingSaveFormDirect",
        fields: CSRF,
      }),
    });
    expect(actionRuns).toBe(1);
    expect(result.response.status).toBe(500);
    expect(result.response.headers.get("x-item-route-mw")).toBe("ran");
    expect(result.body).toContain("item boundary guard=target");
  });

  it("a lock in global middleware that disallows mutations is refused before the action runs", async () => {
    await expect(
      serveShellRequest(router, "/public-2?lock=strict", {
        cacheStore: new MemorySegmentCacheStore(),
        form: createActionForm(saveForm, {
          id: "actions.ts#saveFormLocked",
          fields: CSRF,
        }),
      }),
    ).rejects.toThrow("refused a mutation: .disallowMutations() was set");
    expect(actionRuns).toBe(0);
  });
});

/** A JS action from the page at `url`, sent as the browser sends it. */
async function actionFrom(
  url: string,
  id: string,
): Promise<{
  shown: Metadata;
  result: Awaited<ReturnType<typeof serveShellRequest>>;
}> {
  const cacheStore = new MemorySegmentCacheStore();
  const shown = await showPage(url, cacheStore);
  targetGlobalRuns = 0;
  seen.length = 0;
  const result = await serveShellRequest(router, url, {
    cacheStore,
    action: {
      ref: save,
      id,
      segments: shown.matched,
      rewriteTarget: shown.rewriteTarget,
    },
  });
  return { shown, result };
}

function postForm(url: string, id: string) {
  return serveShellRequest(router, url, {
    cacheStore: new MemorySegmentCacheStore(),
    form: createActionForm(saveForm, { id, fields: CSRF }),
  });
}

describe("an action from a page whose route middleware rewrites only GETs", () => {
  it("a JS action re-renders the page it shows and runs once", async () => {
    const { shown, result } = await actionFrom("/skip-1", "actions.ts#skip");
    expect(actionRuns).toBe(1);
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("x-rango-rewrite")).toBe("/item/1");
    const revalidated = metadata(result.flight);
    expect(revalidated.routeName).toBe("item");
    expect(revalidated.matched).toEqual(shown.matched);
    expect(revalidated.pathname).toBe("/skip-1");
    expect(result.flight).toContain("item 1 guard=target runs=1");
    expect(result.flight).not.toContain("fallback");
    expect(targetGlobalRuns).toBe(1);
    expect(errors).toEqual([]);
  });

  it("a no-JS form post re-renders the page it shows and runs once", async () => {
    const result = await postForm("/skip-2", "actions.ts#skipForm");
    expect(actionRuns).toBe(1);
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("x-rango-rewrite")).toBe("/item/2");
    expect(result.body).toContain("item 2 guard=target runs=1");
    expect(result.body).not.toContain("fallback");
    expect(metadata(result.flight).pathname).toBe("/skip-2");
    expect(result.formState).toBeDefined();
    expect(errors).toEqual([]);
  });
});

describe("route middleware around the render after an action", () => {
  it("sees the page's GET in JS and no-JS, while global middleware sees the POST", async () => {
    await actionFrom("/item/1", "actions.ts#seenJs");
    expect(seen).toEqual(["global:POST", "action", "route:GET:no-body"]);

    seen.length = 0;
    await postForm("/item/2", "actions.ts#seenForm");
    expect(seen).toEqual(["global:POST", "action", "route:GET:no-body"]);
  });
});

// A page a global rewrite reached (#1145): the rewrite of the POST moves it to
// the target before the action runs (RW3).
describe("an action from a page a global rewrite reached", () => {
  it("a JS action moves to the target first: its global middleware, the action once, its route middleware and render", async () => {
    const { shown, result } = await actionFrom(
      "/global-1",
      "actions.ts#saveGlobal",
    );
    expect(actionRuns).toBe(1);
    expect(seen).toEqual(["global:POST", "action", "route:GET:no-body"]);
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("x-rango-rewrite")).toBe("/item/1");
    const revalidated = metadata(result.flight);
    expect(revalidated.routeName).toBe("item");
    expect(revalidated.matched).toEqual(shown.matched);
    expect(revalidated.pathname).toBe("/global-1");
    expect(result.flight).toContain("item 1 guard=target runs=1");
    expect(await result.readAction()).toMatchObject({
      ok: true,
      result: "saved",
    });
    expect(errors).toEqual([]);
  });

  it("a no-JS form post moves to the target with its body: the action reads the form", async () => {
    const result = await serveShellRequest(router, "/global-2", {
      cacheStore: new MemorySegmentCacheStore(),
      form: createActionForm(saveForm, {
        id: "actions.ts#saveFormGlobal",
        fields: { ...CSRF, note: "kept" },
      }),
    });
    expect(actionRuns).toBe(1);
    expect(savedNote).toBe("kept");
    expect(seen).toEqual(["global:POST", "action", "route:GET:no-body"]);
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("x-rango-rewrite")).toBe("/item/2");
    expect(result.body).toContain("item 2 guard=target runs=1");
    expect(result.body).not.toContain("fallback");
    expect(metadata(result.flight).pathname).toBe("/global-2");
    expect(result.formState).toBeDefined();
    expect(errors).toEqual([]);
  });

  it("the target's global middleware guards the moved action", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const shown = await showPage("/global-1", cacheStore);
    const result = await serveShellRequest(router, "/global-1", {
      cacheStore,
      headers: { "x-deny": "1" },
      action: {
        ref: save,
        id: "actions.ts#saveGlobalDenied",
        segments: shown.matched,
      },
    });
    expect(result.response.status).toBe(403);
    expect(result.body).toBe("Denied");
    expect(actionRuns).toBe(0);
  });

  it("is refused before the action runs when global middleware read the body: the action would get no arguments", async () => {
    await expect(
      serveShellRequest(router, "/global-read-4", {
        cacheStore: new MemorySegmentCacheStore(),
        action: { ref: save, id: "actions.ts#saveRead" },
      }),
    ).rejects.toThrow(
      'rewrite("/item/4") is not supported here: middleware read the request body before it threw it',
    );
    expect(actionRuns).toBe(0);
    expect(errors.map((e) => e.phase)).toEqual(["routing"]);
  });

  it.each([
    ["/global-api", "/api/item is a response route"],
    ["/global-slash-1", "/item/1/ redirects"],
  ])(
    "a JS action moved to a target that cannot run it (%s) fails with the rule, and never runs",
    async (url, reason) => {
      await expect(
        serveShellRequest(router, url, {
          cacheStore: new MemorySegmentCacheStore(),
          action: { ref: save, id: `actions.ts#saveMoved${url}` },
        }),
      ).rejects.toThrow(
        `A rewrite of a server action or form post must target a page route; ${reason}.`,
      );
      expect(actionRuns).toBe(0);
    },
  );

  it("a global rewrite written for GETs only leaves the mutation on the visitor's route", async () => {
    // Global middleware wraps the action, so it decides once: a rewrite it
    // skips for mutations is not made, and the action runs where it was
    // posted. Rewrite every method instead.
    const { result } = await actionFrom("/global-get-1", "actions.ts#saveGet");
    expect(actionRuns).toBe(1);
    expect(result.response.headers.get("x-rango-rewrite")).toBeNull();
    expect(metadata(result.flight).routeName).toBe("fallback");
  });
});

describe("a global lock that disallows mutations", () => {
  it.each([
    "/global-lock-3",
    "/global-lock-shell-3",
    "/global-lock-shell-first-3",
  ])(
    "%s refuses a JS action and a no-JS form post before the action runs",
    async (url) => {
      await expect(
        serveShellRequest(router, url, {
          cacheStore: new MemorySegmentCacheStore(),
          action: { ref: save, id: `actions.ts#saveLocked${url}` },
        }),
      ).rejects.toThrow(
        'rewrite("/item/3") refused a mutation: .disallowMutations() was set',
      );
      await expect(
        postForm(url, `actions.ts#saveFormLocked${url}`),
      ).rejects.toThrow("refused a mutation: .disallowMutations() was set");
      expect(actionRuns).toBe(0);
      expect(seen).toEqual([]);
      expect(errors.map((e) => e.phase)).toEqual(["routing", "routing"]);
    },
  );

  it("rewrites a GET as usual", async () => {
    const page = await serveShellRequest(router, "/global-lock-shell-3", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(page.response.status).toBe(200);
    expect(page.response.headers.get("x-rango-rewrite")).toBe("/item/3");
    expect(page.body).toContain("item 3 guard=target runs=0");
  });
});

describe("a route-middleware rewrite that disallows mutations", () => {
  // This suite runs production; dev warns on every throw instead (applyRewrite
  // unit test).
  it("cannot refuse the action, which already ran: the render moves to the target, and production logs it once", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { result } = await actionFrom(
        "/route-lock-5",
        "actions.ts#saveRouteLock",
      );
      expect(actionRuns).toBe(1);
      expect(result.response.status).toBe(200);
      expect(result.response.headers.get("x-rango-rewrite")).toBe("/item/5");
      expect(metadata(result.flight).routeName).toBe("item");

      const form = await postForm("/route-lock-6", "actions.ts#formRouteLock");
      expect(actionRuns).toBe(2);
      expect(form.response.status).toBe(200);
      expect(form.body).toContain("item 6 guard=target runs=2");
      expect(errors).toEqual([]);

      const lateLock = logged.mock.calls.filter(([message]) =>
        String(message).includes(".disallowMutations() came after"),
      );
      expect(lateLock).toHaveLength(1);
      expect(String(lateLock[0]![0])).toContain(
        'rewrite("/item/5").disallowMutations() came after the server action or form post ran, so it cannot refuse it',
      );
    } finally {
      logged.mockRestore();
    }
  });
});
