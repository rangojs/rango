/**
 * Two routers with the same routes, names and paths: nothing but the router
 * tells their output apart (issue #1065). Every route names the app that
 * rendered it, so a response served from the other router's entry shows.
 */
import React from "react";
import { vi } from "vitest";
import {
  createLoader,
  createRouter,
  createVar,
  urls,
  type HandlerContext,
  type Rango,
} from "../../../index.rsc.js";
import {
  MemorySegmentCacheStore,
  createDocumentCacheMiddleware,
  type SegmentCacheStore,
} from "../../../cache/index.js";
import { CFCacheStore } from "../../../cache/cf/cf-cache-store.js";
import {
  VercelCacheStore,
  type VercelRuntimeCache,
} from "../../../cache/vercel/vercel-cache-store.js";

export type App = "a" | "b";

/** Handler runs per router: a request served from an entry runs none. */
export const runs: Record<App, number> = { a: 0, b: 0 };

/** Body runs of the shared loader and `"use cache"` functions. */
export const sharedRuns = { loader: 0, navFor: 0, pathOf: 0 };

export function resetRuns(): void {
  runs.a = 0;
  runs.b = 0;
  sharedRuns.loader = 0;
  sharedRuns.navFor = 0;
  sharedRuns.pathOf = 0;
}

/** Set by each router's own middleware. */
const Brand = createVar<string>();

/** One loader definition both routers mount, with its own cache(). */
const BrandLoader = createLoader(async (ctx) => {
  sharedRuns.loader += 1;
  return { brand: ctx.get(Brand) };
});

/** Takes `ctx`: reads the calling router's reverse() map. */
async function navFor(ctx: HandlerContext): Promise<string> {
  "use cache";
  sharedRuns.navFor += 1;
  return (ctx.reverse as (name: string) => string)("other");
}

/** Takes the bare Request: reads nothing of the calling router. */
async function pathOf(request: Request): Promise<string> {
  "use cache";
  sharedRuns.pathOf += 1;
  return `${new URL(request.url).pathname}#${sharedRuns.pathOf}`;
}

export type TestRouter = Rango<any, any>;

export function makeRouter(
  app: App,
  store: SegmentCacheStore,
  options: { version?: string; id?: string } = {},
): TestRouter {
  const ran = (): void => {
    runs[app] += 1;
  };
  return createRouter({
    id: options.id ?? `app-${app}`,
    cache: { store },
    cacheProfiles: { default: { ttl: 300 } },
    ...(options.version !== undefined && { version: options.version }),
  })
    .use(async (ctx, next) => {
      ctx.set(Brand, `brand-${app}`);
      await next();
    })
    .use("/stored", createDocumentCacheMiddleware())
    .routes(
      urls(({ path, cache, loader }) => [
        path(
          "/shelled",
          () => {
            ran();
            return <h1>{`app-${app}-page`}</h1>;
          },
          { name: "shelled", ppr: true },
        ),
        cache({ ttl: 300 }, () => [
          path(
            "/cached",
            () => {
              ran();
              return <p>{`app-${app}-cached`}</p>;
            },
            { name: "cached" },
          ),
          path.json(
            "/api/data",
            () => {
              ran();
              return { from: `app-${app}` };
            },
            { name: "data" },
          ),
        ]),
        path(
          "/stored",
          (ctx: HandlerContext) => {
            ran();
            ctx.headers.set("Cache-Control", "s-maxage=60");
            return <p>{`app-${app}-stored`}</p>;
          },
          { name: "stored" },
        ),
        path(
          "/loader",
          async (ctx: HandlerContext) => {
            const { brand } = await ctx.use(BrandLoader);
            return <p>{`app-${app}-loader:${brand}`}</p>;
          },
          { name: "loader" },
          () => [loader(BrandLoader, () => [cache({ ttl: 300 })])],
        ),
        path(`/${app}-other`, () => <p>other</p>, { name: "other" }),
        path(
          "/fn",
          async (ctx: HandlerContext) => (
            <p>{`app-${app}-fn:${await navFor(ctx)}`}</p>
          ),
          { name: "fn" },
        ),
        path(
          "/fn-request",
          async (ctx: HandlerContext) => (
            <p>{`app-${app}-request:${await pathOf(ctx.request)}`}</p>
          ),
          { name: "fnRequest" },
        ),
      ]),
    );
}

export function makeRouters(
  store: SegmentCacheStore,
  options: { version?: string; ids?: Record<App, string> } = {},
): Record<App, TestRouter> {
  const { version, ids } = options;
  return {
    a: makeRouter("a", store, { version, id: ids?.a }),
    b: makeRouter("b", store, { version, id: ids?.b }),
  };
}

export interface ShellServed {
  shell: string | null;
  prelude: string[];
  pages: string[];
}

/** The pages a text names: one router's, never the other's. */
function pagesIn(text: string | undefined): string[] {
  return [...new Set(text?.match(/app-[ab]-page/g) ?? [])];
}

/** What a `/shelled` response was served from and whose page it shows. */
export function shellServed(result: {
  shellStatus: string | null;
  prelude?: string;
  body: string;
}): ShellServed {
  return {
    shell: result.shellStatus,
    prelude: pagesIn(result.prelude),
    pages: pagesIn(result.body),
  };
}

/** A document the router rendered itself. */
export const ownMiss = (app: App): ShellServed => ({
  shell: "MISS",
  prelude: [],
  pages: [`app-${app}-page`],
});

/** A HIT whose prelude and tail are the router's own page. */
export const ownHit = (app: App): ShellServed => ({
  shell: "HIT",
  prelude: [`app-${app}-page`],
  pages: [`app-${app}-page`],
});

export interface StoreUnderTest {
  cacheStore: SegmentCacheStore;
  /** Settle the store's background writes started so far. */
  settle(): Promise<void>;
}

/** An execution context double whose waitUntil tasks settle() drains. */
function executionContext() {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
    passThroughOnException: () => {},
    async settle() {
      while (pending.length) await Promise.all(pending.splice(0));
    },
  };
}

/**
 * One store both routers use, visible to every location, as the KV-backed
 * store of a deployed multi-router worker is.
 */
export function memoryStore(): StoreUnderTest {
  return {
    cacheStore: new MemorySegmentCacheStore({ scope: "global" }),
    settle: async () => {},
  };
}

/** CFCacheStore over a Cache API double and a KV double. */
export function cfStore(): StoreUnderTest & { kvKeys(): string[] } {
  const entries = new Map<string, Response>();
  const edge = {
    async match(request: Request) {
      return entries.get(request.url)?.clone();
    },
    async put(request: Request, response: Response) {
      entries.set(request.url, response.clone());
    },
    async delete(request: Request) {
      return entries.delete(request.url);
    },
  };
  vi.stubGlobal("caches", { default: edge, open: async () => edge });
  const values = new Map<string, string>();
  const kv = {
    async get(key: string, getOptions?: { type?: string }) {
      const value = values.get(key);
      if (value === undefined) return null;
      return getOptions?.type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
  };
  const ctx = executionContext();
  return {
    cacheStore: new CFCacheStore({ ctx: ctx as never, kv: kv as never }),
    settle: () => ctx.settle(),
    kvKeys: () => [...values.keys()],
  };
}

/** VercelCacheStore over a runtime cache double. */
export function vercelStore(): StoreUnderTest {
  const values = new Map<string, unknown>();
  const ctx = executionContext();
  const cache: VercelRuntimeCache = {
    async get(key) {
      const value = values.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    async set(key, value) {
      values.set(key, structuredClone(value));
    },
    async delete(key) {
      values.delete(key);
    },
    async expireTag() {},
  };
  return {
    cacheStore: new VercelCacheStore({ cache, waitUntil: ctx.waitUntil }),
    settle: () => ctx.settle(),
  };
}
