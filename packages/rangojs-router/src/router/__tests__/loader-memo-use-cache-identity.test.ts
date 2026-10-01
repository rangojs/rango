/**
 * The request memo's ctx.use(Loader) read inside a "use cache" body (#1011):
 * createLoaderExecutor's memo hit returns a value whose body ran outside the
 * cached function, so the identity guard never saw its reads. The read now
 * refuses a value whose execution (or one it read) recorded an identity read,
 * once it settles, and the cached function's write refuses one recorded after
 * that (assertLoaderReadsClean). Drives the production RequestContext,
 * HandlerContext and setupLoaderAccess; the "use cache" scope is entered with
 * runWithCacheExecScope, as cache-runtime.ts does.
 */
import { describe, expect, it } from "vitest";
import {
  createRequestContext,
  getRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import {
  createCacheExecScope,
  runIdentityExempt,
  runWithCacheExecScope,
} from "../../cache/cache-exec-scope.js";
import { assertLoaderReadsClean } from "../../cache/cache-tag.js";
import { createVar } from "../../context-var.js";
import { createHandlerContext } from "../handler-context.js";
import { setupLoaderAccess } from "../loader-resolution.js";
import type {
  HandlerContext,
  LoaderContext,
  LoaderDefinition,
} from "../../types.js";

const Tenant = createVar<string>({ cache: false });

const REFUSED =
  'ctx.get() for a non-cacheable variable cannot be called inside a "use cache" function';

function loaderDef<T>(
  id: string,
  fn: (ctx: LoaderContext) => Promise<T>,
): LoaderDefinition<T> {
  return { __brand: "loader", $$id: id, fn } as unknown as LoaderDefinition<T>;
}

function inRequest<T>(
  fn: (hctx: HandlerContext<any>, reqCtx: RequestContext<any>) => T,
): T {
  const url = new URL("https://shop.test/nav");
  const reqCtx: RequestContext<any> = createRequestContext({
    env: {},
    request: new Request(url),
    url,
    variables: {},
  });
  reqCtx.set(Tenant, "a");
  return runWithRequestContext(reqCtx, () => {
    const hctx = createHandlerContext(
      {},
      reqCtx.request,
      reqCtx.searchParams,
      reqCtx.pathname,
      reqCtx.url,
    );
    setupLoaderAccess(hctx, new Map());
    return fn(hctx, reqCtx);
  });
}

const tick = (ms = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const TenantLoader = loaderDef(
  "test#1011:Tenant",
  async () => `tenant-${getRequestContext().get(Tenant)}`,
);
const PlainLoader = loaderDef("test#1011:Plain", async () => "plain");

describe('memo hit inside a "use cache" body (#1011)', () => {
  it("refuses a value whose execution read request identity, naming the loader", async () => {
    await inRequest(async (hctx) => {
      expect(await hctx.use(TenantLoader)).toBe("tenant-a");

      const read = runWithCacheExecScope(() => hctx.use(TenantLoader));
      await expect(read).rejects.toThrow(REFUSED);
      await expect(read).rejects.toThrow(
        'Loader "test#1011:Tenant" called it, and the cached function reads that loader\'s value',
      );
    });
  });

  it("refuses a read the body makes after an await, while the value is pending", async () => {
    const SlowTenant = loaderDef("test#1011:SlowTenant", async () => {
      await tick(5);
      return `tenant-${getRequestContext().get(Tenant)}`;
    });
    await inRequest(async (hctx) => {
      const started = hctx.use(SlowTenant);
      const read = runWithCacheExecScope(() => hctx.use(SlowTenant));
      await expect(read).rejects.toThrow(REFUSED);
      expect(await started).toBe("tenant-a");
    });
  });

  it("refuses a value built from another loader's identity read, naming both", async () => {
    const Profile = loaderDef(
      "test#1011:Profile",
      async (ctx) => `profile-${await ctx.use(TenantLoader)}`,
    );
    await inRequest(async (hctx) => {
      await hctx.use(Profile);

      await expect(
        runWithCacheExecScope(() => hctx.use(Profile)),
      ).rejects.toThrow(
        'Loader "test#1011:Tenant" called it, and the cached function reads loader "test#1011:Profile"',
      );
    });
  });

  it("returns a value that read no identity, and outside the scope the memo itself", async () => {
    await inRequest(async (hctx) => {
      const memo = hctx.use(PlainLoader);
      expect(hctx.use(PlainLoader)).toBe(memo);

      expect(await runWithCacheExecScope(() => hctx.use(PlainLoader))).toBe(
        "plain",
      );
      // Outside a "use cache" body an identity-reading memo is unchanged.
      const tenant = hctx.use(TenantLoader);
      expect(hctx.use(TenantLoader)).toBe(tenant);
    });
  });

  it("returns the value inside a cache's own key() or tags() (runIdentityExempt)", async () => {
    await inRequest(async (hctx) => {
      await hctx.use(TenantLoader);

      expect(
        await runWithCacheExecScope(() =>
          runIdentityExempt(() => hctx.use(TenantLoader)),
        ),
      ).toBe("tenant-a");
    });
  });

  it("a read after the value settled: the read passes, and the write check refuses it", async () => {
    const LateTenant = loaderDef("test#1011:LateTenant", async () => ({
      tenant: (async () => {
        await tick(5);
        return `late-${getRequestContext().get(Tenant)}`;
      })(),
    }));
    await inRequest(async (hctx) => {
      await hctx.use(LateTenant);
      const scope = createCacheExecScope();

      const value = await runWithCacheExecScope(
        () => hctx.use(LateTenant),
        scope,
      );
      expect(() => assertLoaderReadsClean(scope)).not.toThrow();
      expect(await value.tenant).toBe("late-a");
      expect(() => assertLoaderReadsClean(scope)).toThrow(REFUSED);
    });
  });

  it('an enclosing "use cache" execution checks the read too', async () => {
    await inRequest(async (hctx) => {
      await hctx.use(TenantLoader);
      const outer = createCacheExecScope();

      await runWithCacheExecScope(
        () =>
          runWithCacheExecScope(() => hctx.use(TenantLoader)).catch(() => {}),
        outer,
      );
      expect(() => assertLoaderReadsClean(outer)).toThrow(REFUSED);
    });
  });

  it("notes a value read twice in one execution once", async () => {
    await inRequest(async (hctx) => {
      await hctx.use(PlainLoader);
      const scope = createCacheExecScope();

      await runWithCacheExecScope(async () => {
        await hctx.use(PlainLoader);
        await hctx.use(PlainLoader);
      }, scope);
      expect(scope.loaderReads?.size).toBe(1);
    });
  });

  it("a read the body never awaits is not an unhandled rejection; the write check still refuses it", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await inRequest(async (hctx) => {
        await hctx.use(TenantLoader);
        const scope = createCacheExecScope();

        runWithCacheExecScope(() => {
          void hctx.use(TenantLoader);
        }, scope);
        await tick(5);

        expect(unhandled).toEqual([]);
        expect(() => assertLoaderReadsClean(scope)).toThrow(REFUSED);
      });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe('getRequestContext().use() inside a "use cache" body (#1011)', () => {
  it("refuses a memoized value whose run read request identity, and records reads of a run it started", async () => {
    await inRequest(async (_hctx, reqCtx) => {
      expect(await reqCtx.use(TenantLoader)).toBe("tenant-a");

      await expect(
        runWithCacheExecScope(() => reqCtx.use(TenantLoader)),
      ).rejects.toThrow(
        'Loader "test#1011:Tenant" called it, and the cached function reads that loader\'s value',
      );
      expect(await runWithCacheExecScope(() => reqCtx.use(PlainLoader))).toBe(
        "plain",
      );
    });
  });
});
