import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { urls } from "../urls.js";
import { RSCRouterContext, type EntryData } from "../server/context.js";

// These are the helpers we want to export globally from @rangojs/router.
// Currently they're module-level consts in route-definition.ts.
// Import them directly to test they work outside the urls() callback parameter.
import {
  layout,
  cache,
  middleware,
  revalidate,
  loader,
  loading,
  parallel,
  intercept,
  when,
  errorBoundary,
  notFoundBoundary,
} from "../route-definition.js";

// Type imports for composition typing
import type {
  RouteUseItem,
  LayoutUseItem,
  AllUseItems,
  UseItems,
} from "../route-types.js";

// Test helpers
function createContext() {
  const manifest = new Map<string, EntryData>();
  const patterns = new Map<string, string>();
  return { manifest, patterns };
}

function runInContext(ctx: ReturnType<typeof createContext>, fn: () => any) {
  let result: any;
  RSCRouterContext.run(
    {
      manifest: ctx.manifest,
      patterns: ctx.patterns,
      namespace: "test",
      parent: null,
      counters: {},
    },
    () => {
      result = fn();
    },
  );
  return result;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("global helper imports", () => {
  let ctx: ReturnType<typeof createContext>;

  beforeEach(() => {
    ctx = createContext();
  });

  afterEach(() => {
    ctx.manifest.clear();
    ctx.patterns.clear();
  });

  // -------------------------------------------------------------------------
  // 1. Basic: global imports produce valid items inside urls() context
  // -------------------------------------------------------------------------

  describe("helpers produce valid items inside urls() context", () => {
    it("cache() returns a CacheItem", () => {
      const urlPatterns = urls(({ path }) => [
        path(
          "/",
          () => <div>Home</div>,
          { name: "home" },
          () => [cache({ ttl: 60_000 })],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      expect(ctx.manifest.has("home")).toBe(true);
    });

    it("revalidate() returns a RevalidateItem", () => {
      const urlPatterns = urls(({ path }) => [
        path(
          "/",
          () => <div>Home</div>,
          { name: "home" },
          () => [revalidate(({ actionId }) => !!actionId)],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      expect(ctx.manifest.has("home")).toBe(true);
    });

    it("middleware() returns a MiddlewareItem", () => {
      const testMiddleware = async (ctx: any, next: any) => next();

      const urlPatterns = urls(({ path }) => [
        path(
          "/",
          () => <div>Home</div>,
          { name: "home" },
          () => [middleware(testMiddleware)],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      expect(ctx.manifest.has("home")).toBe(true);
    });

    it("loading() returns a LoadingItem", () => {
      const urlPatterns = urls(({ path }) => [
        path(
          "/",
          () => <div>Home</div>,
          { name: "home" },
          () => [loading(<div>Loading...</div>)],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      expect(ctx.manifest.has("home")).toBe(true);
    });

    it("errorBoundary() returns an ErrorBoundaryItem", () => {
      const urlPatterns = urls(({ path }) => [
        path(
          "/",
          () => <div>Home</div>,
          { name: "home" },
          () => [errorBoundary(() => <div>Error</div>)],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      expect(ctx.manifest.has("home")).toBe(true);
    });

    it("notFoundBoundary() returns a NotFoundBoundaryItem", () => {
      const urlPatterns = urls(({ path }) => [
        path(
          "/",
          () => <div>Home</div>,
          { name: "home" },
          () => [notFoundBoundary(() => <div>Not Found</div>)],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      expect(ctx.manifest.has("home")).toBe(true);
    });

    it("layout() wraps children correctly", () => {
      const urlPatterns = urls(({ path }) => [
        layout(
          () => <div>Layout</div>,
          () => [path("/", () => <div>Home</div>, { name: "home" })],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      expect(ctx.manifest.has("home")).toBe(true);
    });

    it("parallel() creates parallel slots", () => {
      const urlPatterns = urls(({ path }) => [
        layout(
          () => <div>Layout</div>,
          () => [
            path("/", () => <div>Home</div>, { name: "home" }),
            parallel({ "@sidebar": () => <div>Sidebar</div> }),
          ],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      expect(ctx.manifest.has("home")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Composition: callback factories work inside urls() builder
  // -------------------------------------------------------------------------

  describe("composable callback factories", () => {
    it("cache + revalidate composition works inside path() use callback", () => {
      const withCaching = (): RouteUseItem[] => [
        cache({ ttl: 600_000 }),
        revalidate(({ actionId }) => !!actionId),
      ];

      const urlPatterns = urls(({ path }) => [
        path(
          "/",
          () => <div>Home</div>,
          { name: "home" },
          () => [withCaching()],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      const entry = ctx.manifest.get("home");
      expect(entry).toBeDefined();
    });

    it("middleware composition works inside layout() use callback", () => {
      const authMiddleware = async (ctx: any, next: any) => next();
      const loggingMiddleware = async (ctx: any, next: any) => next();

      const withAuth = (): LayoutUseItem[] => [
        middleware(authMiddleware),
        middleware(loggingMiddleware),
      ];

      const urlPatterns = urls(({ path }) => [
        layout(
          () => <div>Layout</div>,
          () => [
            withAuth(),
            path("/", () => <div>Home</div>, { name: "home" }),
          ],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      expect(ctx.manifest.has("home")).toBe(true);
    });

    it("multiple compositions can be combined", () => {
      const withCaching = (): RouteUseItem[] => [
        cache({ ttl: 300_000 }),
        revalidate(({ actionId }) => !!actionId),
      ];

      const withLoading = (): RouteUseItem[] => [
        loading(<div>Loading...</div>),
        errorBoundary(() => <div>Error</div>),
      ];

      const urlPatterns = urls(({ path }) => [
        path(
          "/",
          () => <div>Home</div>,
          { name: "home" },
          () => [withCaching(), withLoading()],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      expect(ctx.manifest.has("home")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Nested composition: composed helpers inside layout/path use callbacks
  // -------------------------------------------------------------------------

  describe("nested composition", () => {
    it("layout with composed middleware wrapping paths with composed cache", () => {
      const authMiddleware = async (ctx: any, next: any) => next();

      const withAuth = (): LayoutUseItem[] => [middleware(authMiddleware)];

      const withCaching = (): RouteUseItem[] => [cache({ ttl: 600_000 })];

      const urlPatterns = urls(({ path }) => [
        layout(
          () => <div>App</div>,
          () => [
            withAuth(),
            path(
              "/",
              () => <div>Home</div>,
              { name: "home" },
              () => [withCaching()],
            ),
            path(
              "/about",
              () => <div>About</div>,
              { name: "about" },
              () => [withCaching()],
            ),
          ],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      expect(ctx.manifest.has("home")).toBe(true);
      expect(ctx.manifest.has("about")).toBe(true);
    });

    it("shared layout composition reused across multiple urls() calls", () => {
      const standardLayout = (): LayoutUseItem[] => [
        middleware(async (ctx: any, next: any) => next()),
        revalidate(({ actionId }) => !!actionId),
      ];

      const blogPatterns = urls(({ path }) => [
        layout(
          () => <div>Blog</div>,
          () => [
            standardLayout(),
            path("/blog", () => <div>Blog</div>, { name: "blog.index" }),
          ],
        ),
      ]);

      const shopPatterns = urls(({ path }) => [
        layout(
          () => <div>Shop</div>,
          () => [
            standardLayout(),
            path("/shop", () => <div>Shop</div>, { name: "shop.index" }),
          ],
        ),
      ]);

      runInContext(ctx, () => blogPatterns.handler());
      expect(ctx.manifest.has("blog.index")).toBe(true);

      // Fresh context for second urls() call
      const ctx2 = createContext();
      runInContext(ctx2, () => shopPatterns.handler());
      expect(ctx2.manifest.has("shop.index")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Flattening: nested arrays from composed helpers get flattened
  // -------------------------------------------------------------------------

  describe("array flattening", () => {
    it("nested arrays from factory return are flattened", () => {
      const withEverything = (): RouteUseItem[] => [
        cache({ ttl: 60_000 }),
        revalidate(({ actionId }) => !!actionId),
        loading(<div>Loading...</div>),
      ];

      const urlPatterns = urls(({ path }) => [
        path(
          "/",
          () => <div>Home</div>,
          { name: "home" },
          () => [
            // This returns an array inside the use callback array
            // The .flat(3) should handle it
            withEverything(),
          ],
        ),
      ]);

      // Should not throw
      runInContext(ctx, () => urlPatterns.handler());
      expect(ctx.manifest.has("home")).toBe(true);
    });

    it("deeply nested factory compositions flatten correctly", () => {
      const base = (): RouteUseItem[] => [cache()];
      const extended = (): UseItems<RouteUseItem> => [
        base(),
        revalidate(({ actionId }) => !!actionId),
      ];

      const urlPatterns = urls(({ path }) => [
        path(
          "/",
          () => <div>Home</div>,
          { name: "home" },
          () => [...extended()],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      expect(ctx.manifest.has("home")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Context errors: helpers throw when called outside urls() context
  // -------------------------------------------------------------------------

  describe("context errors", () => {
    it("cache() throws outside context", () => {
      expect(() => cache()).toThrow();
    });

    it("layout() throws outside context", () => {
      expect(() => layout(() => <div>Layout</div>)).toThrow();
    });

    it("middleware() throws outside context", () => {
      expect(() => middleware(async (ctx: any, next: any) => next())).toThrow();
    });

    it("revalidate() throws outside context", () => {
      expect(() => revalidate(({ actionId }) => !!actionId)).toThrow();
    });

    it("parallel() throws outside context", () => {
      expect(() => parallel({ "@slot": () => <div>Slot</div> })).toThrow();
    });

    it("loading() throws outside context", () => {
      expect(() => loading(<div>Loading</div>)).toThrow();
    });

    it("errorBoundary() throws outside context", () => {
      expect(() => errorBoundary(() => <div>Error</div>)).toThrow();
    });

    it("notFoundBoundary() throws outside context", () => {
      expect(() => notFoundBoundary(() => <div>Not Found</div>)).toThrow();
    });

    it("callback factories do NOT throw at definition time", () => {
      // These are just function definitions - no context needed
      expect(() => {
        const withCache = (): RouteUseItem[] => [cache({ ttl: 60_000 })];
        // withCache is defined but NOT called
        void withCache;
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // 6. Type exports: ensure composition types are importable
  // -------------------------------------------------------------------------

  describe("type compatibility", () => {
    it("RouteUseItem typed factory works in path() use callback", () => {
      const factory: () => RouteUseItem[] = () => [
        cache({ ttl: 60_000 }),
        revalidate(({ actionId }) => !!actionId),
      ];

      const urlPatterns = urls(({ path }) => [
        path(
          "/",
          () => <div>Home</div>,
          { name: "home" },
          () => [factory()],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      expect(ctx.manifest.has("home")).toBe(true);
    });

    it("LayoutUseItem typed factory works in layout() use callback", () => {
      const factory: () => LayoutUseItem[] = () => [
        middleware(async (ctx: any, next: any) => next()),
      ];

      const urlPatterns = urls(({ path }) => [
        layout(
          () => <div>Layout</div>,
          () => [factory(), path("/", () => <div>Home</div>, { name: "home" })],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      expect(ctx.manifest.has("home")).toBe(true);
    });

    it("AllUseItems typed factory works in top-level builder", () => {
      const factory: () => AllUseItems[] = () => [
        layout(() => <div>Wrapper</div>),
      ];

      const urlPatterns = urls(({ path }) => [
        factory(),
        path("/", () => <div>Home</div>, { name: "home" }),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      expect(ctx.manifest.has("home")).toBe(true);
    });
  });
});
