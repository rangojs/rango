/**
 * Location state on document responses (#1330), through the public
 * serveShellRequest and createActionForm primitives:
 * - a document request's handler or middleware state rides its bootstrap
 *   payload, and the document leaves `private, no-store`;
 * - a document request's redirect carries it in a one-shot cookie, which the
 *   target's document request reads into its payload and clears;
 * - a no-JS form post's action state rides the re-rendered document, or the
 *   cookie when the action redirects;
 * - such a document is never stored by the document cache; a PPR shell never
 *   holds it, and a ppr route whose state is set before the render (middleware,
 *   the cookie) still serves and captures its shell, the state riding the live
 *   payload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { withLocationStateKey } from "../location-state-key.js";
import {
  createLocationState,
  createRouter,
  getRequestContext,
  redirect,
  urls,
  type HandlerContext,
  type Middleware,
} from "../../index.rsc.js";
import {
  MemorySegmentCacheStore,
  createDocumentCacheMiddleware,
} from "../../cache/index.js";

const Flash = withLocationStateKey(
  createLocationState<{ text: string }>({ flash: true }),
  "Flash",
);
const Note = withLocationStateKey(
  createLocationState<{ text: string }>(),
  "Note",
);
const FLASH = Flash.__rsc_ls_key;
const NOTE = Note.__rsc_ls_key;

const CACHE_CONTROL = "s-maxage=60, stale-while-revalidate=300";

let renders = 0;

function FlashPage(ctx: HandlerContext): React.ReactNode {
  ctx.setLocationState(Flash({ text: "verified" }));
  return <p>verified page</p>;
}

function CachedFlashPage(ctx: HandlerContext): React.ReactNode {
  ctx.headers.set("Cache-Control", CACHE_CONTROL);
  ctx.setLocationState(Flash({ text: `render-${++renders}` }));
  return <p>cached flash page</p>;
}

function CachedPlainPage(ctx: HandlerContext): React.ReactNode {
  ctx.headers.set("Cache-Control", CACHE_CONTROL);
  return <p>{`render-${++renders}`}</p>;
}

const toTarget: Middleware = () =>
  redirect("/target", { state: [Flash({ text: "redirected" })] });

const toSecondHop: Middleware = () =>
  redirect("/hop", { state: [Note({ text: "first hop" })] });

const hopOn: Middleware = () => redirect("/target");

const offHost: Middleware = () =>
  redirect("https://payments.example.com/back", {
    state: [Flash({ text: "off host" })],
    external: true,
  });

const tooLarge: Middleware = () =>
  redirect("/target", { state: [Note({ text: "x".repeat(5000) })] });

const setsNote: Middleware = async (ctx, next) => {
  ctx.setLocationState(Note({ text: "from middleware" }));
  await next();
};

async function savingAction(_form: FormData): Promise<void> {
  getRequestContext().setLocationState(Flash({ text: "saved" }));
}

async function redirectingAction(_form: FormData): Promise<void> {
  throw redirect("/target", { status: 303, state: [Flash({ text: "paid" })] });
}

function makeRouter() {
  return createRouter({})
    .use(createDocumentCacheMiddleware())
    .use("/callback", toTarget)
    .use("/chain", toSecondHop)
    .use("/hop", hopOn)
    .use("/off-host", offHost)
    .use("/too-large", tooLarge)
    .use("/shelled-mw", setsNote)
    .routes(
      urls(({ path }) => [
        path("/verify", FlashPage, { name: "verify" }),
        path("/target", () => <p>target page</p>, { name: "target" }),
        path("/plain", () => <p>plain page</p>, { name: "plain" }),
        path(
          "/empty",
          (ctx) => {
            ctx.setLocationState([]);
            return <p>empty state page</p>;
          },
          { name: "empty" },
        ),
        path("/callback", () => <p>never rendered</p>, { name: "callback" }),
        path("/chain", () => <p>never rendered</p>, { name: "chain" }),
        path("/hop", () => <p>never rendered</p>, { name: "hop" }),
        path("/off-host", () => <p>never rendered</p>, { name: "offHost" }),
        path("/too-large", () => <p>never rendered</p>, { name: "tooLarge" }),
        path("/cached-flash", CachedFlashPage, { name: "cachedFlash" }),
        path("/cached-plain", CachedPlainPage, { name: "cachedPlain" }),
        path("/shelled", FlashPage, { name: "shelled", ppr: true }),
        path("/shelled-mw", () => <p>shelled mw</p>, {
          name: "shelledMw",
          ppr: true,
        }),
        path("/shelled-plain", () => <p>shelled plain</p>, {
          name: "shelledPlain",
          ppr: true,
        }),
        path("/form", () => <p>form page</p>, { name: "form" }),
      ]),
    );
}

/** The `name=value` of the document location state cookie a response sets. */
function stateCookie(response: Response): string | undefined {
  return response.headers
    .getSetCookie()
    .find((cookie) => /-ls=/.test(cookie.split(";")[0]!));
}

function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0]!;
}

beforeEach(async () => {
  renders = 0;
  await resetShellTestState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("location state on a document response (#1330)", () => {
  it("rides the bootstrap payload when the handler sets it, and the document is private", async () => {
    const result = await serveShellRequest(makeRouter(), "/verify");

    expect(result.response.status).toBe(200);
    expect(await result.readLocationState()).toEqual({
      [FLASH]: { text: "verified" },
    });
    expect(result.response.headers.get("cache-control")).toBe(
      "private, no-store",
    );
  });

  it("leaves a document without state as it was", async () => {
    const result = await serveShellRequest(makeRouter(), "/plain");

    expect(await result.readLocationState()).toBeUndefined();
    expect(result.response.headers.get("cache-control")).toBeNull();
    expect(stateCookie(result.response)).toBeUndefined();
  });

  it("treats an empty state list as no state", async () => {
    const result = await serveShellRequest(makeRouter(), "/empty");

    expect(await result.readLocationState()).toBeUndefined();
    expect(result.response.headers.get("cache-control")).toBeNull();
  });

  it("carries a document redirect's state in a one-shot cookie the target reads", async () => {
    const router = makeRouter();
    const redirected = await serveShellRequest(router, "/callback");

    expect(redirected.response.status).toBe(302);
    expect(redirected.response.headers.get("location")).toBe("/target");
    expect(redirected.response.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    const set = stateCookie(redirected.response)!;
    expect(set).toMatch(/^rango-state_[^=]*-ls=/);
    expect(set).toContain("Path=/");
    expect(set).toContain("Max-Age=60");
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=lax");
    expect(set).not.toContain("Secure");

    const target = await serveShellRequest(router, "/target", {
      headers: { cookie: cookiePair(set) },
    });

    expect(await target.readLocationState()).toEqual({
      [FLASH]: { text: "redirected" },
    });
    expect(target.response.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    // Cleared by the response that read it: a refresh renders without it.
    expect(stateCookie(target.response)).toMatch(/Max-Age=0/);
  });

  it("names the cookie __Host- and marks it Secure on https", async () => {
    const result = await serveShellRequest(
      makeRouter(),
      "https://shop.example.com/callback",
    );

    const set = stateCookie(result.response)!;
    expect(set).toMatch(/^__Host-rango-state_[^=]*-ls=/);
    expect(set).toContain("Secure");
    expect(set).toContain("Path=/");
  });

  it("is left alone by a request of another pathname", async () => {
    const router = makeRouter();
    const set = stateCookie(
      (await serveShellRequest(router, "/callback")).response,
    )!;

    const other = await serveShellRequest(router, "/plain", {
      headers: { cookie: cookiePair(set) },
    });

    expect(await other.readLocationState()).toBeUndefined();
    expect(stateCookie(other.response)).toBeUndefined();
  });

  it("is left to the navigation by a prefetch or fetch() of the target", async () => {
    const router = makeRouter();
    const set = stateCookie(
      (await serveShellRequest(router, "/callback")).response,
    )!;

    // A <link rel=prefetch> or a same-path fetch(): a document request by
    // mayNeedSSR, but Sec-Fetch-Dest names no browsing context.
    const prefetch = await serveShellRequest(router, "/target", {
      headers: {
        cookie: cookiePair(set),
        accept: "*/*",
        "sec-fetch-dest": "empty",
      },
    });
    expect(await prefetch.readLocationState()).toBeUndefined();
    expect(stateCookie(prefetch.response)).toBeUndefined();
    expect(prefetch.response.headers.get("cache-control")).toBeNull();

    const navigation = await serveShellRequest(router, "/target", {
      headers: { cookie: cookiePair(set), "sec-fetch-dest": "document" },
    });
    expect(await navigation.readLocationState()).toEqual({
      [FLASH]: { text: "redirected" },
    });
    expect(stateCookie(navigation.response)).toMatch(/Max-Age=0/);
  });

  it("clears a malformed cookie and carries nothing from it", async () => {
    const router = makeRouter();
    const name = cookiePair(
      stateCookie((await serveShellRequest(router, "/callback")).response)!,
    ).split("=")[0];

    const result = await serveShellRequest(router, "/target", {
      headers: { cookie: `${name}=not-json` },
    });

    expect(await result.readLocationState()).toBeUndefined();
    expect(stateCookie(result.response)).toMatch(/Max-Age=0/);
  });

  it("takes only typed slots from the cookie", async () => {
    const router = makeRouter();
    const name = cookiePair(
      stateCookie((await serveShellRequest(router, "/callback")).response)!,
    ).split("=")[0];
    const value = encodeURIComponent(
      JSON.stringify({
        p: "/target",
        s: { [NOTE]: { text: "kept" }, idx: 7, state: { plain: true } },
      }),
    );

    const result = await serveShellRequest(router, "/target", {
      headers: { cookie: `${name}=${value}` },
    });

    expect(await result.readLocationState()).toEqual({
      [NOTE]: { text: "kept" },
    });
  });

  it("carries the state on across a second redirect", async () => {
    const router = makeRouter();
    const first = stateCookie(
      (await serveShellRequest(router, "/chain")).response,
    )!;

    const hop = await serveShellRequest(router, "/hop", {
      headers: { cookie: cookiePair(first) },
    });
    expect(hop.response.headers.get("location")).toBe("/target");
    const cookies = hop.response.headers
      .getSetCookie()
      .filter((cookie) => /-ls=/.test(cookie.split(";")[0]!));
    // The hop clears the cookie it read, then sets the one for /target.
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(/Max-Age=0/);

    const target = await serveShellRequest(router, "/target", {
      headers: { cookie: cookiePair(cookies[1]!) },
    });
    expect(await target.readLocationState()).toEqual({
      [NOTE]: { text: "first hop" },
    });
  });

  it("sets no cookie on an external redirect", async () => {
    const result = await serveShellRequest(makeRouter(), "/off-host");

    expect(result.response.headers.get("location")).toBe(
      "https://payments.example.com/back",
    );
    expect(stateCookie(result.response)).toBeUndefined();
  });

  it("drops state whose cookie would exceed the size limit, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await serveShellRequest(makeRouter(), "/too-large");

    expect(result.response.status).toBe(302);
    expect(stateCookie(result.response)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("over the 4000-byte limit"),
    );
  });
});

describe("location state on a no-JS form post (#1330)", () => {
  it("rides the re-rendered document when the action sets it", async () => {
    const result = await serveShellRequest(makeRouter(), "/form", {
      form: createActionForm(savingAction, {
        id: "actions/form#savingAction",
        useActionState: false,
      }),
    });

    expect(result.response.status).toBe(200);
    expect(await result.readLocationState()).toEqual({
      [FLASH]: { text: "saved" },
    });
    expect(result.response.headers.get("cache-control")).toBe(
      "private, no-store",
    );
  });

  it("crosses the action's 303 to the target in the cookie", async () => {
    const router = makeRouter();
    const post = await serveShellRequest(router, "/form", {
      form: createActionForm(redirectingAction, {
        id: "actions/form#redirectingAction",
        useActionState: false,
      }),
    });

    expect(post.response.status).toBe(303);
    const set = stateCookie(post.response)!;
    const target = await serveShellRequest(router, "/target", {
      headers: { cookie: cookiePair(set) },
    });
    expect(await target.readLocationState()).toEqual({
      [FLASH]: { text: "paid" },
    });
  });
});

describe("caching a document that carries location state (#1330)", () => {
  it("is not stored by the document cache", async () => {
    const router = makeRouter();
    const cacheStore = new MemorySegmentCacheStore();

    const first = await serveShellRequest(router, "/cached-flash", {
      cacheStore,
    });
    const second = await serveShellRequest(router, "/cached-flash", {
      cacheStore,
    });

    expect(await first.readLocationState()).toEqual({
      [FLASH]: { text: "render-1" },
    });
    expect(await second.readLocationState()).toEqual({
      [FLASH]: { text: "render-2" },
    });
    expect(second.response.headers.get("x-document-cache-status")).not.toBe(
      "HIT",
    );
  });

  it("is not answered from a stored document when the request carries the cookie", async () => {
    const router = makeRouter();
    const cacheStore = new MemorySegmentCacheStore();
    await serveShellRequest(router, "/cached-plain", { cacheStore });
    const warm = await serveShellRequest(router, "/cached-plain", {
      cacheStore,
    });
    expect(warm.response.headers.get("x-document-cache-status")).toBe("HIT");

    const name = cookiePair(
      stateCookie((await serveShellRequest(router, "/callback")).response)!,
    ).split("=")[0];
    const value = encodeURIComponent(
      JSON.stringify({ p: "/cached-plain", s: { [FLASH]: { text: "hi" } } }),
    );
    const carried = await serveShellRequest(router, "/cached-plain", {
      cacheStore,
      headers: { cookie: `${name}=${value}` },
    });

    expect(carried.response.headers.get("x-document-cache-status")).toBeNull();
    expect(carried.body).toContain("render-2");
    expect(await carried.readLocationState()).toEqual({
      [FLASH]: { text: "hi" },
    });

    // The stored document still answers everyone else.
    const after = await serveShellRequest(router, "/cached-plain", {
      cacheStore,
    });
    expect(after.response.headers.get("x-document-cache-status")).toBe("HIT");
    expect(after.body).toContain("render-1");
  });

  it("is never captured as a PPR shell when the handler sets it", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const router = makeRouter();

    const first = await serveShellRequest(router, "/shelled", { cacheStore });
    expect(await first.readLocationState()).toEqual({
      [FLASH]: { text: "verified" },
    });
    expect(await first.readEntry()).toBeNull();

    const second = await serveShellRequest(router, "/shelled", { cacheStore });
    expect(second.shellStatus).not.toBe("HIT");
    expect(await second.readLocationState()).toEqual({
      [FLASH]: { text: "verified" },
    });
  });

  it("serves and captures the shell of a ppr route when middleware sets it, the state riding the live payload", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const router = makeRouter();

    const miss = await serveShellRequest(router, "/shelled-mw", {
      cacheStore,
    });
    expect(miss.shellStatus).toBe("MISS");
    expect(await miss.readLocationState()).toEqual({
      [NOTE]: { text: "from middleware" },
    });
    expect(miss.response.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expect(await miss.readEntry()).not.toBeNull();

    const hit = await serveShellRequest(router, "/shelled-mw", { cacheStore });
    expect(hit.shellStatus).toBe("HIT");
    expect(hit.body).toContain("shelled mw");
    expect(await hit.readLocationState()).toEqual({
      [NOTE]: { text: "from middleware" },
    });
    expect(hit.response.headers.get("cache-control")).toBe("private, no-store");
    // The shared shell holds none of it: the state is the tail's.
    expect(hit.prelude).not.toContain("from middleware");
  });

  it("serves a ppr route's shell to a request carrying a redirect's cookie, with the state on that response only", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const router = makeRouter();
    expect(
      (await serveShellRequest(router, "/shelled-plain", { cacheStore }))
        .shellStatus,
    ).toBe("MISS");

    const name = cookiePair(
      stateCookie((await serveShellRequest(router, "/callback")).response)!,
    ).split("=")[0];
    const value = encodeURIComponent(
      JSON.stringify({ p: "/shelled-plain", s: { [FLASH]: { text: "hi" } } }),
    );
    const carried = await serveShellRequest(router, "/shelled-plain", {
      cacheStore,
      headers: { cookie: `${name}=${value}`, "sec-fetch-dest": "document" },
    });
    expect(carried.shellStatus).toBe("HIT");
    expect(await carried.readLocationState()).toEqual({
      [FLASH]: { text: "hi" },
    });
    expect(carried.response.headers.get("cache-control")).toBe(
      "private, no-store",
    );

    const after = await serveShellRequest(router, "/shelled-plain", {
      cacheStore,
    });
    expect(after.shellStatus).toBe("HIT");
    expect(await after.readLocationState()).toBeUndefined();
    expect(after.response.headers.get("cache-control")).not.toBe(
      "private, no-store",
    );
  });
});
