import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { urls } from "../urls.js";
import { map } from "../route-definition.js";
import { RangoContext, type EntryData } from "../server/context.js";
import {
  layout,
  middleware,
  loader,
  loading,
  parallel,
  intercept,
  when,
  revalidate,
  errorBoundary,
  cache,
} from "../route-definition.js";
import { createLoader } from "../loader.rsc.js";
import type { Handler } from "../types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createContext() {
  const manifest = new Map<string, EntryData>();
  const patterns = new Map<string, string>();
  return { manifest, patterns };
}

function runInContext(ctx: ReturnType<typeof createContext>, fn: () => any) {
  let result: any;
  RangoContext.run(
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

describe("handler.use integration", () => {
  let ctx: ReturnType<typeof createContext>;

  beforeEach(() => {
    ctx = createContext();
  });

  afterEach(() => {
    ctx.manifest.clear();
    ctx.patterns.clear();
  });

  // -----------------------------------------------------------------------
  // path() with handler.use
  // -----------------------------------------------------------------------

  describe("path()", () => {
    it("applies handler.use items", () => {
      const testMw = async (_ctx: any, next: any) => next();
      const Page: Handler = Object.assign(() => <div>Page</div>, {
        use: () => [middleware(testMw)],
      });

      const urlPatterns = urls(({ path }) => [
        path("/", Page, { name: "home" }),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      const entry = ctx.manifest.get("home");
      expect(entry).toBeDefined();
      expect(entry!.middleware).toContain(testMw);
    });

    it("merges handler.use before explicit use", () => {
      const mwA = async (_ctx: any, next: any) => next();
      const mwB = async (_ctx: any, next: any) => next();

      const Page: Handler = Object.assign(() => <div>Page</div>, {
        use: () => [middleware(mwA)],
      });

      const urlPatterns = urls(({ path }) => [
        path("/", Page, { name: "home" }, () => [middleware(mwB)]),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      const entry = ctx.manifest.get("home");
      expect(entry!.middleware).toEqual([mwA, mwB]);
    });

    it("handler.use loading overridden by explicit loading", () => {
      const DefaultLoading = <div>Default Loading</div>;
      const ExplicitLoading = <div>Explicit Loading</div>;

      const Page: Handler = Object.assign(() => <div>Page</div>, {
        use: () => [loading(DefaultLoading)],
      });

      const urlPatterns = urls(({ path }) => [
        path("/", Page, { name: "home" }, () => [loading(ExplicitLoading)]),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      const entry = ctx.manifest.get("home");
      // loading is last-write-wins: explicit overrides handler.use
      expect(entry!.loading).toBe(ExplicitLoading);
    });

    it("works without handler.use (no regression)", () => {
      const urlPatterns = urls(({ path }) => [
        path("/", () => <div>Home</div>, { name: "home" }),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      expect(ctx.manifest.has("home")).toBe(true);
    });

    it("works with handler.use only, no explicit use", () => {
      const testMw = async (_ctx: any, next: any) => next();
      const Page: Handler = Object.assign(() => <div>Page</div>, {
        use: () => [middleware(testMw)],
      });

      const urlPatterns = urls(({ path }) => [
        path("/", Page, { name: "home" }),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      const entry = ctx.manifest.get("home");
      expect(entry!.middleware).toContain(testMw);
    });
  });

  // -----------------------------------------------------------------------
  // layout() with handler.use
  // -----------------------------------------------------------------------

  describe("layout()", () => {
    it("applies handler.use items", () => {
      const testMw = async (_ctx: any, next: any) => next();
      const Layout: Handler = Object.assign(() => <div>Layout</div>, {
        use: () => [middleware(testMw)],
      });

      const urlPatterns = urls(({ path }) => [
        layout(Layout, () => [
          path("/", () => <div>Home</div>, { name: "home" }),
        ]),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      const entry = ctx.manifest.get("home");
      expect(entry).toBeDefined();
      // Middleware attaches to the layout entry, not the route entry.
      // Find the layout entry through the route's parent chain.
      let layoutEntry = entry!.parent;
      while (layoutEntry && layoutEntry.type !== "layout") {
        layoutEntry = layoutEntry.parent;
      }
      expect(layoutEntry).toBeDefined();
      expect(layoutEntry!.middleware).toContain(testMw);
    });

    it("merges handler.use before explicit use", () => {
      const mwA = async (_ctx: any, next: any) => next();
      const mwB = async (_ctx: any, next: any) => next();

      const Layout: Handler = Object.assign(() => <div>Layout</div>, {
        use: () => [middleware(mwA)],
      });

      const urlPatterns = urls(({ path }) => [
        layout(Layout, () => [
          middleware(mwB),
          path("/", () => <div>Home</div>, { name: "home" }),
        ]),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      const entry = ctx.manifest.get("home");
      let layoutEntry = entry!.parent;
      while (layoutEntry && layoutEntry.type !== "layout") {
        layoutEntry = layoutEntry.parent;
      }
      expect(layoutEntry!.middleware).toEqual([mwA, mwB]);
    });
  });

  // -----------------------------------------------------------------------
  // parallel() with handler.use
  // -----------------------------------------------------------------------

  describe("parallel()", () => {
    it("applies slot handler.use items to parallel entry", () => {
      const revalidateFn = () => true;
      const Sidebar: Handler = Object.assign(() => <div>Sidebar</div>, {
        use: () => [revalidate(revalidateFn)],
      });

      const urlPatterns = urls(({ path }) => [
        layout(
          () => <div>Layout</div>,
          () => [
            path("/", () => <div>Home</div>, { name: "home" }),
            parallel({ "@sidebar": Sidebar }),
          ],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      const entry = ctx.manifest.get("home");
      let layoutEntry = entry!.parent;
      while (layoutEntry && layoutEntry.type !== "layout") {
        layoutEntry = layoutEntry.parent;
      }
      const sidebarEntry = layoutEntry?.parallel?.["@sidebar"];
      expect(sidebarEntry).toBeDefined();
      expect(sidebarEntry!.revalidate).toContain(revalidateFn);
    });

    it("multi-slot handler.use does not bleed across slots", () => {
      const sidebarRevalidate = () => true;
      const mainRevalidate = () => false;
      const Sidebar: Handler = Object.assign(() => <div>Sidebar</div>, {
        use: () => [revalidate(sidebarRevalidate)],
      });
      const Main: Handler = Object.assign(() => <div>Main</div>, {
        use: () => [revalidate(mainRevalidate)],
      });

      const urlPatterns = urls(({ path }) => [
        layout(
          () => <div>Layout</div>,
          () => [
            path("/", () => <div>Home</div>, { name: "home" }),
            parallel({ "@sidebar": Sidebar, "@main": Main }),
          ],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      const entry = ctx.manifest.get("home");
      let layoutEntry = entry!.parent;
      while (layoutEntry && layoutEntry.type !== "layout") {
        layoutEntry = layoutEntry.parent;
      }

      const sidebarEntry = layoutEntry?.parallel?.["@sidebar"];
      const mainEntry = layoutEntry?.parallel?.["@main"];

      // Each slot should only have its own handler's revalidate
      expect(sidebarEntry!.revalidate).toContain(sidebarRevalidate);
      expect(sidebarEntry!.revalidate).not.toContain(mainRevalidate);

      expect(mainEntry!.revalidate).toContain(mainRevalidate);
      expect(mainEntry!.revalidate).not.toContain(sidebarRevalidate);
    });

    it("explicit use applies to all slots, handler.use stays per-slot", () => {
      const sharedRevalidate = () => true;
      const sidebarRevalidate = () => false;
      const Sidebar: Handler = Object.assign(() => <div>Sidebar</div>, {
        use: () => [revalidate(sidebarRevalidate)],
      });
      const Main: Handler = Object.assign(() => <div>Main</div>, {});

      const urlPatterns = urls(({ path }) => [
        layout(
          () => <div>Layout</div>,
          () => [
            path("/", () => <div>Home</div>, { name: "home" }),
            parallel({ "@sidebar": Sidebar, "@main": Main }, () => [
              revalidate(sharedRevalidate),
            ]),
          ],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      const entry = ctx.manifest.get("home");
      let layoutEntry = entry!.parent;
      while (layoutEntry && layoutEntry.type !== "layout") {
        layoutEntry = layoutEntry.parent;
      }

      const sidebarEntry = layoutEntry?.parallel?.["@sidebar"];
      const mainEntry = layoutEntry?.parallel?.["@main"];

      // Both slots get the shared explicit revalidate
      expect(sidebarEntry!.revalidate).toContain(sharedRevalidate);
      expect(mainEntry!.revalidate).toContain(sharedRevalidate);

      // Only sidebar gets its own handler.use revalidate
      expect(sidebarEntry!.revalidate).toContain(sidebarRevalidate);
      expect(mainEntry!.revalidate).not.toContain(sidebarRevalidate);
    });

    it("explicit loading() overrides handler.use loading() (last-write-wins)", () => {
      const DefaultLoading = <div>Default Loading</div>;
      const ExplicitLoading = <div>Explicit Loading</div>;

      const Sidebar: Handler = Object.assign(() => <div>Sidebar</div>, {
        use: () => [loading(DefaultLoading)],
      });

      const urlPatterns = urls(({ path }) => [
        layout(
          () => <div>Layout</div>,
          () => [
            path("/", () => <div>Home</div>, { name: "home" }),
            parallel({ "@sidebar": Sidebar }, () => [loading(ExplicitLoading)]),
          ],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      const entry = ctx.manifest.get("home");
      let layoutEntry = entry!.parent;
      while (layoutEntry && layoutEntry.type !== "layout") {
        layoutEntry = layoutEntry.parent;
      }

      const sidebarEntry = layoutEntry?.parallel?.["@sidebar"];
      // Explicit loading must win over handler.use default
      expect(sidebarEntry!.loading).toBe(ExplicitLoading);
    });

    it("rejects invalid items from slot handler.use", () => {
      const Sidebar: Handler = Object.assign(() => <div>Sidebar</div>, {
        use: () => [middleware(async (_c: any, n: any) => n())],
      });

      const urlPatterns = urls(({ path }) => [
        layout(
          () => <div>Layout</div>,
          () => [
            path("/", () => <div>Home</div>, { name: "home" }),
            parallel({ "@sidebar": Sidebar }),
          ],
        ),
      ]);

      expect(() => runInContext(ctx, () => urlPatterns.handler())).toThrow(
        /handler\.use\(\) returned middleware\(\).*parallel\(\)/,
      );
    });

    // -------------------------------------------------------------------
    // Per-slot use via slot descriptor `{ handler, use }`
    // -------------------------------------------------------------------

    it("slot-local use applies only to that slot, not siblings", () => {
      const SidebarLoading = <div>Sidebar Loading</div>;
      const Sidebar: Handler = () => <div>Sidebar</div>;
      const Main: Handler = () => <div>Main</div>;

      const urlPatterns = urls(({ path }) => [
        layout(
          () => <div>Layout</div>,
          () => [
            path("/", () => <div>Home</div>, { name: "home" }),
            parallel({
              "@sidebar": {
                handler: Sidebar,
                use: () => [loading(SidebarLoading)],
              },
              "@main": Main,
            }),
          ],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      const entry = ctx.manifest.get("home");
      let layoutEntry = entry!.parent;
      while (layoutEntry && layoutEntry.type !== "layout") {
        layoutEntry = layoutEntry.parent;
      }

      const sidebarEntry = layoutEntry?.parallel?.["@sidebar"];
      const mainEntry = layoutEntry?.parallel?.["@main"];

      // Only @sidebar gets the loading; @main is untouched
      expect(sidebarEntry!.loading).toBe(SidebarLoading);
      expect(mainEntry!.loading).toBeUndefined();
    });

    it("slot-local loading wins over shared (broadcast) loading", () => {
      const SharedLoading = <div>Shared</div>;
      const SlotLoading = <div>Slot Local</div>;
      const Sidebar: Handler = () => <div>Sidebar</div>;
      const Main: Handler = () => <div>Main</div>;

      const urlPatterns = urls(({ path }) => [
        layout(
          () => <div>Layout</div>,
          () => [
            path("/", () => <div>Home</div>, { name: "home" }),
            parallel(
              {
                "@sidebar": {
                  handler: Sidebar,
                  use: () => [loading(SlotLoading)],
                },
                "@main": Main,
              },
              () => [loading(SharedLoading)],
            ),
          ],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      const entry = ctx.manifest.get("home");
      let layoutEntry = entry!.parent;
      while (layoutEntry && layoutEntry.type !== "layout") {
        layoutEntry = layoutEntry.parent;
      }

      const sidebarEntry = layoutEntry?.parallel?.["@sidebar"];
      const mainEntry = layoutEntry?.parallel?.["@main"];

      // narrowest-wins: slot-local beats broadcast on @sidebar
      expect(sidebarEntry!.loading).toBe(SlotLoading);
      // @main has no slot-local; broadcast applies
      expect(mainEntry!.loading).toBe(SharedLoading);
    });

    it("slot-local loading(false) opts a slot out while siblings still stream", () => {
      const SharedLoading = <div>Shared</div>;
      const Sidebar: Handler = () => <div>Sidebar</div>;
      const Main: Handler = () => <div>Main</div>;

      const urlPatterns = urls(({ path }) => [
        layout(
          () => <div>Layout</div>,
          () => [
            path("/", () => <div>Home</div>, { name: "home" }),
            parallel(
              {
                "@sidebar": {
                  handler: Sidebar,
                  use: () => [loading(false)],
                },
                "@main": Main,
              },
              () => [loading(SharedLoading)],
            ),
          ],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      const entry = ctx.manifest.get("home");
      let layoutEntry = entry!.parent;
      while (layoutEntry && layoutEntry.type !== "layout") {
        layoutEntry = layoutEntry.parent;
      }

      const sidebarEntry = layoutEntry?.parallel?.["@sidebar"];
      const mainEntry = layoutEntry?.parallel?.["@main"];

      // Slot opted out → no streaming for this slot
      expect(sidebarEntry!.loading).toBe(false);
      // Sibling still gets the broadcast skeleton
      expect(mainEntry!.loading).toBe(SharedLoading);
    });

    it("merge order: handler.use → shared use → slot-local use", () => {
      const HandlerLoading = <div>Handler</div>;
      const SharedLoading = <div>Shared</div>;
      const SlotLoading = <div>Slot</div>;

      const Sidebar: Handler = Object.assign(() => <div>Sidebar</div>, {
        use: () => [loading(HandlerLoading)],
      });

      const urlPatterns = urls(({ path }) => [
        layout(
          () => <div>Layout</div>,
          () => [
            path("/", () => <div>Home</div>, { name: "home" }),
            parallel(
              {
                "@sidebar": {
                  handler: Sidebar,
                  use: () => [loading(SlotLoading)],
                },
              },
              () => [loading(SharedLoading)],
            ),
          ],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      const entry = ctx.manifest.get("home");
      let layoutEntry = entry!.parent;
      while (layoutEntry && layoutEntry.type !== "layout") {
        layoutEntry = layoutEntry.parent;
      }

      const sidebarEntry = layoutEntry?.parallel?.["@sidebar"];
      // All three layers run; last one wins for single-assignment loading()
      expect(sidebarEntry!.loading).toBe(SlotLoading);
    });

    it("accumulating items from all three layers compose for the slot", () => {
      const handlerRevalidate = () => true;
      const sharedRevalidate = () => true;
      const slotRevalidate = () => true;
      const Sidebar: Handler = Object.assign(() => <div>Sidebar</div>, {
        use: () => [revalidate(handlerRevalidate)],
      });

      const urlPatterns = urls(({ path }) => [
        layout(
          () => <div>Layout</div>,
          () => [
            path("/", () => <div>Home</div>, { name: "home" }),
            parallel(
              {
                "@sidebar": {
                  handler: Sidebar,
                  use: () => [revalidate(slotRevalidate)],
                },
              },
              () => [revalidate(sharedRevalidate)],
            ),
          ],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      const entry = ctx.manifest.get("home");
      let layoutEntry = entry!.parent;
      while (layoutEntry && layoutEntry.type !== "layout") {
        layoutEntry = layoutEntry.parent;
      }

      const sidebarEntry = layoutEntry?.parallel?.["@sidebar"];
      // All three accumulate
      expect(sidebarEntry!.revalidate).toContain(handlerRevalidate);
      expect(sidebarEntry!.revalidate).toContain(sharedRevalidate);
      expect(sidebarEntry!.revalidate).toContain(slotRevalidate);
    });

    it("slot-local use is treated as explicit (mount-site authored), not validated against the handler.use allow-list", () => {
      // Slot-local use is authored at the mount site like the shared use
      // callback — both bypass the handler.use mount-site validation, which
      // exists because handlers don't know their mount site at definition
      // time. The user authoring `parallel({...})` knows where they are.
      const RevalSidebar: Handler = () => <div>Sidebar</div>;
      const reval = () => true;

      const urlPatterns = urls(({ path }) => [
        layout(
          () => <div>Layout</div>,
          () => [
            path("/", () => <div>Home</div>, { name: "home" }),
            parallel({
              "@sidebar": {
                handler: RevalSidebar,
                use: () => [revalidate(reval)],
              },
            }),
          ],
        ),
      ]);

      expect(() =>
        runInContext(ctx, () => urlPatterns.handler()),
      ).not.toThrow();
      const entry = ctx.manifest.get("home");
      let layoutEntry = entry!.parent;
      while (layoutEntry && layoutEntry.type !== "layout") {
        layoutEntry = layoutEntry.parent;
      }
      expect(layoutEntry?.parallel?.["@sidebar"]?.revalidate).toContain(reval);
    });
  });

  // -----------------------------------------------------------------------
  // intercept() with handler.use
  // -----------------------------------------------------------------------

  describe("intercept()", () => {
    it("applies handler.use items to intercept entry", () => {
      const testMw = async (_ctx: any, next: any) => next();
      const InterceptHandler: Handler = Object.assign(
        () => <div>Intercept</div>,
        {
          use: () => [middleware(testMw)],
        },
      );

      const urlPatterns = urls(({ path }) => [
        layout(
          () => <div>Layout</div>,
          () => [
            path("/", () => <div>Home</div>, { name: "home" }),
            intercept("@modal", "home", InterceptHandler),
          ],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      const entry = ctx.manifest.get("home");
      let layoutEntry = entry!.parent;
      while (layoutEntry && layoutEntry.type !== "layout") {
        layoutEntry = layoutEntry.parent;
      }
      const interceptEntry = layoutEntry?.intercept?.[0];
      expect(interceptEntry).toBeDefined();
      expect(interceptEntry!.middleware).toContain(testMw);
    });

    it("handler.use items reach the intercept entry via runtime merging", () => {
      // A redundant but explicit assertion that intercept() walks the full
      // resolveHandlerUse → mergeHandlerUse path for loaders/revalidate too,
      // not just middleware.
      const revalidateFn = () => true;
      const loaderDef = {
        __brand: "loader" as const,
        $$id: "int-loader",
        fn: async () => ({}),
      };
      const InterceptHandler: Handler = Object.assign(
        () => <div>Intercept</div>,
        {
          use: () => [loader(loaderDef as any), revalidate(revalidateFn)],
        },
      );

      const urlPatterns = urls(({ path }) => [
        layout(
          () => <div>Layout</div>,
          () => [
            path("/", () => <div>Home</div>, { name: "home" }),
            intercept("@modal", "home", InterceptHandler),
          ],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      const entry = ctx.manifest.get("home");
      let layoutEntry = entry!.parent;
      while (layoutEntry && layoutEntry.type !== "layout") {
        layoutEntry = layoutEntry.parent;
      }
      const interceptEntry = layoutEntry?.intercept?.[0];
      expect(interceptEntry!.revalidate).toContain(revalidateFn);
      expect(interceptEntry!.loader.map((l) => l.loader)).toContain(loaderDef);
    });

    it("merges handler.use before explicit use in intercept", () => {
      const mwA = async (_ctx: any, next: any) => next();
      const mwB = async (_ctx: any, next: any) => next();

      const InterceptHandler: Handler = Object.assign(
        () => <div>Intercept</div>,
        {
          use: () => [middleware(mwA)],
        },
      );

      const urlPatterns = urls(({ path }) => [
        layout(
          () => <div>Layout</div>,
          () => [
            path("/", () => <div>Home</div>, { name: "home" }),
            intercept("@modal", "home", InterceptHandler, () => [
              middleware(mwB),
            ]),
          ],
        ),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      const entry = ctx.manifest.get("home");
      let layoutEntry = entry!.parent;
      while (layoutEntry && layoutEntry.type !== "layout") {
        layoutEntry = layoutEntry.parent;
      }
      const interceptEntry = layoutEntry?.intercept?.[0];
      expect(interceptEntry!.middleware).toEqual([mwA, mwB]);
    });
  });

  // -----------------------------------------------------------------------
  // loader() with handler.use (LoaderDefinition.use)
  // -----------------------------------------------------------------------

  describe("loader()", () => {
    const makeLoaderDef = (use?: () => any[]) =>
      ({
        __brand: "loader" as const,
        $$id: "test-loader",
        fn: async () => ({ ok: true }),
        ...(use ? { use } : {}),
      }) as any;

    const mountLoader = (loaderDef: any, explicitUse?: () => any[]) =>
      urls(({ path }) => [
        path(
          "/",
          () => <div>Home</div>,
          { name: "home" },
          () => [loader(loaderDef, explicitUse)],
        ),
      ]);

    it("applies handler.use revalidate to the loader entry", () => {
      const revalidateFn = () => true;
      const loaderDef = makeLoaderDef(() => [revalidate(revalidateFn)]);

      runInContext(ctx, () => mountLoader(loaderDef).handler());
      const entry = ctx.manifest.get("home");
      const loaderEntry = entry!.loader.find(
        (le: any) => le.loader === loaderDef,
      );
      expect(loaderEntry).toBeDefined();
      expect(loaderEntry!.revalidate).toContain(revalidateFn);
    });

    it("applies handler.use cache to the loader entry", () => {
      const loaderDef = makeLoaderDef(() => [cache({ ttl: 1000 })]);

      runInContext(ctx, () => mountLoader(loaderDef).handler());
      const entry = ctx.manifest.get("home");
      const loaderEntry = entry!.loader.find(
        (le: any) => le.loader === loaderDef,
      );
      expect(loaderEntry).toBeDefined();
      expect((loaderEntry as any).cache).toBeDefined();
    });

    it("merges handler.use before explicit use on a loader", () => {
      const revA = () => true;
      const revB = () => false;
      const loaderDef = makeLoaderDef(() => [revalidate(revA)]);

      runInContext(ctx, () =>
        mountLoader(loaderDef, () => [revalidate(revB)]).handler(),
      );
      const entry = ctx.manifest.get("home");
      const loaderEntry = entry!.loader.find(
        (le: any) => le.loader === loaderDef,
      );
      expect(loaderEntry!.revalidate).toEqual([revA, revB]);
    });

    it("rejects invalid items (middleware) in loader mount", () => {
      const testMw = async (_ctx: any, next: any) => next();
      const loaderDef = makeLoaderDef(() => [middleware(testMw)]);

      expect(() =>
        runInContext(ctx, () => mountLoader(loaderDef).handler()),
      ).toThrow(/handler\.use\(\) returned middleware\(\).*loader\(\)/);
    });

    it("works without handler.use on loader (no regression)", () => {
      const loaderDef = makeLoaderDef();

      runInContext(ctx, () => mountLoader(loaderDef).handler());
      const entry = ctx.manifest.get("home");
      expect(entry!.loader.length).toBe(1);
      expect(entry!.loader[0].revalidate).toEqual([]);
    });

    it("rejects cache wrapper form in loader mount (via handler.use)", () => {
      // cache(() => [...]) passes item-type validation, but wrapper form has
      // no effect on the loader entry — it would silently no-op. Reject it.
      const loaderDef = makeLoaderDef(() => [cache(() => [])]);

      expect(() =>
        runInContext(ctx, () => mountLoader(loaderDef).handler()),
      ).toThrow(/cache\(\) wrapper form is not valid inside loader\(\)/);
    });

    it("rejects cache wrapper form in loader mount (via explicit use)", () => {
      const loaderDef = makeLoaderDef();

      expect(() =>
        runInContext(ctx, () =>
          mountLoader(loaderDef, () => [cache(() => [])]).handler(),
        ),
      ).toThrow(/cache\(\) wrapper form is not valid inside loader\(\)/);
    });
  });

  // -----------------------------------------------------------------------
  // route() with handler.use
  // -----------------------------------------------------------------------

  describe("route()", () => {
    it("applies handler.use items to the route entry", () => {
      const testMw = async (_ctx: any, next: any) => next();
      const Page: Handler = Object.assign(() => <div>Page</div>, {
        use: () => [middleware(testMw)],
      });

      const handlers = map(({ route }) => [(route as any)("home", Page)]);
      runInContext(ctx, () => handlers());
      const entry = ctx.manifest.get("home");
      expect(entry).toBeDefined();
      expect(entry!.middleware).toContain(testMw);
    });

    it("merges handler.use before explicit use on route()", () => {
      const mwA = async (_ctx: any, next: any) => next();
      const mwB = async (_ctx: any, next: any) => next();
      const Page: Handler = Object.assign(() => <div>Page</div>, {
        use: () => [middleware(mwA)],
      });

      const handlers = map(({ route }) => [
        (route as any)("home", Page, () => [middleware(mwB)]),
      ]);
      runInContext(ctx, () => handlers());
      const entry = ctx.manifest.get("home");
      expect(entry!.middleware).toEqual([mwA, mwB]);
    });
  });

  // -----------------------------------------------------------------------
  // Handler definition types with .use
  // -----------------------------------------------------------------------

  describe("handler definitions", () => {
    it("PrerenderHandlerDefinition with .use works in path()", () => {
      const testMw = async (_ctx: any, next: any) => next();
      const def = {
        __brand: "prerenderHandler" as const,
        $$id: "test-id",
        handler: (() => <div>Page</div>) as Handler,
        use: () => [middleware(testMw)],
      };

      const urlPatterns = urls(({ path }) => [
        path("/", def as any, { name: "home" }),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      const entry = ctx.manifest.get("home");
      expect(entry!.middleware).toContain(testMw);
    });

    it("StaticHandlerDefinition with .use works in layout()", () => {
      const testMw = async (_ctx: any, next: any) => next();
      const def = {
        __brand: "staticHandler" as const,
        $$id: "test-id",
        handler: (() => <div>Layout</div>) as Handler,
        use: () => [middleware(testMw)],
      };

      const urlPatterns = urls(({ path }) => [
        layout(def as any, () => [
          path("/", () => <div>Home</div>, { name: "home" }),
        ]),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      const entry = ctx.manifest.get("home");
      let layoutEntry = entry!.parent;
      while (layoutEntry && layoutEntry.type !== "layout") {
        layoutEntry = layoutEntry.parent;
      }
      expect(layoutEntry!.middleware).toContain(testMw);
    });
  });

  // -----------------------------------------------------------------------
  // Response routes (path.json, path.text, etc.)
  // -----------------------------------------------------------------------

  describe("response routes", () => {
    it("path.json() allows handler.use with middleware", () => {
      const testMw = async (_ctx: any, next: any) => next();
      const ApiHandler = Object.assign(() => ({ ok: true }), {
        use: () => [middleware(testMw)],
      });

      const urlPatterns = urls(({ path }) => [
        path.json("/api", ApiHandler as any, { name: "api" }),
      ]);

      runInContext(ctx, () => urlPatterns.handler());
      const entry = ctx.manifest.get("api");
      expect(entry!.middleware).toContain(testMw);
    });

    it("path.json() rejects handler.use with loader", () => {
      const dummyLoader = { $$id: "test", fn: async () => ({}) };
      const ApiHandler = Object.assign(() => ({ ok: true }), {
        use: () => [loader(dummyLoader as any)],
      });

      const urlPatterns = urls(({ path }) => [
        path.json("/api", ApiHandler as any, { name: "api" }),
      ]);

      expect(() => runInContext(ctx, () => urlPatterns.handler())).toThrow(
        /handler\.use\(\) returned loader\(\).*response\(\)/,
      );
    });

    it("path.text() rejects handler.use with parallel", () => {
      const TextHandler = Object.assign(() => "hello", {
        use: () => [parallel({ "@sidebar": () => <div>Sidebar</div> } as any)],
      });

      // parallel() requires a parent with parallel — wrap in layout
      const urlPatterns = urls(({ path }) => [
        layout(
          () => <div>Layout</div>,
          () => [
            path("/dummy", () => <div />, { name: "dummy" }),
            path.text("/text", TextHandler as any, { name: "textRoute" }),
          ],
        ),
      ]);

      expect(() => runInContext(ctx, () => urlPatterns.handler())).toThrow(
        /handler\.use\(\) returned parallel\(\).*response\(\)/,
      );
    });
  });
});
