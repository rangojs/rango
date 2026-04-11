import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { urls, type IncludeItem } from "../urls.js";
import {
  RSCRouterContext,
  runWithPrefixes,
  type EntryData,
} from "../server/context.js";
import { isRouteRootScoped } from "../route-map-builder.js";

/**
 * Helper to simulate lazy include evaluation.
 * In the actual router, this happens when a request matches the include's prefix.
 * For testing, we manually trigger it by calling runWithPrefixes with the captured context.
 */
function evaluateLazyInclude(
  includeItem: IncludeItem & {
    _lazyContext?: {
      urlPrefix: string;
      namePrefix: string | undefined;
      rootScoped?: boolean;
    };
  },
  manifest: Map<string, EntryData>,
  patterns: Map<string, string>,
): any[] {
  const urlPrefix =
    (includeItem._lazyContext?.urlPrefix || "") + includeItem.prefix;
  // _lazyContext.namePrefix already includes the include's own name (fullNamePrefix)
  // so we use it directly without adding the name again
  const namePrefix = includeItem._lazyContext?.namePrefix;

  let items: any[] = [];
  RSCRouterContext.run(
    {
      manifest,
      patterns,
      namespace: "test",
      parent: null,
      counters: {},
      rootScoped: includeItem._lazyContext?.rootScoped,
    },
    () => {
      items = runWithPrefixes(urlPrefix, namePrefix, () => {
        return (includeItem.patterns as any).handler();
      });
    },
  );
  return items;
}

describe("urls()", () => {
  describe("basic structure", () => {
    it("should return UrlPatterns with handler function", () => {
      const patterns = urls(({ path }) => [path("/", () => <div>Home</div>)]);

      expect(typeof patterns.handler).toBe("function");
      expect(patterns.definitions).toEqual([]);
    });

    it("should accept empty array", () => {
      const patterns = urls(() => []);

      expect(typeof patterns.handler).toBe("function");
    });
  });

  describe("path() helper", () => {
    let manifest: Map<string, EntryData>;
    let patterns: Map<string, string>;

    beforeEach(() => {
      manifest = new Map();
      patterns = new Map();
    });

    afterEach(() => {
      manifest.clear();
      patterns.clear();
    });

    it("should register route with pattern only", () => {
      const urlPatterns = urls(({ path }) => [
        path("/about", () => <div>About</div>),
      ]);

      // Execute the handler within context to register routes
      RSCRouterContext.run(
        {
          manifest,
          patterns,
          namespace: "test",
          parent: null,
          counters: {},
        },
        () => urlPatterns.handler(),
      );

      // Should have registered a route
      expect(manifest.size).toBeGreaterThan(0);
    });

    it("should register route with name option", () => {
      const urlPatterns = urls(({ path }) => [
        path("/about", () => <div>About</div>, { name: "about" }),
      ]);

      RSCRouterContext.run(
        {
          manifest,
          patterns,
          namespace: "test",
          parent: null,
          counters: {},
        },
        () => urlPatterns.handler(),
      );

      // Should have registered route with name "about"
      expect(manifest.has("about")).toBe(true);
      expect(patterns.get("about")).toBe("/about");
    });

    it("should store pattern on route entry", () => {
      const urlPatterns = urls(({ path }) => [
        path("/:slug", () => <div>Post</div>, { name: "post" }),
      ]);

      RSCRouterContext.run(
        {
          manifest,
          patterns,
          namespace: "test",
          parent: null,
          counters: {},
        },
        () => urlPatterns.handler(),
      );

      const entry = manifest.get("post");
      expect(entry).toBeDefined();
      expect((entry as any).pattern).toBe("/:slug");
    });

    it("should accept use callback as third argument", () => {
      const urlPatterns = urls(({ path, middleware }) => [
        path(
          "/admin",
          () => <div>Admin</div>,
          () => [middleware(() => {})],
        ),
      ]);

      RSCRouterContext.run(
        {
          manifest,
          patterns,
          namespace: "test",
          parent: null,
          counters: {},
        },
        () => urlPatterns.handler(),
      );

      // Should have a route registered
      expect(manifest.size).toBeGreaterThan(0);
    });

    it("should accept options and use callback", () => {
      const urlPatterns = urls(({ path, middleware }) => [
        path(
          "/admin",
          () => <div>Admin</div>,
          { name: "admin" },
          () => [middleware(() => {})],
        ),
      ]);

      RSCRouterContext.run(
        {
          manifest,
          patterns,
          namespace: "test",
          parent: null,
          counters: {},
        },
        () => urlPatterns.handler(),
      );

      expect(manifest.has("admin")).toBe(true);
    });
  });

  describe("layout() helper", () => {
    let manifest: Map<string, EntryData>;
    let patterns: Map<string, string>;

    beforeEach(() => {
      manifest = new Map();
      patterns = new Map();
    });

    it("should work with path() inside layout", () => {
      const urlPatterns = urls(({ path, layout }) => [
        layout(
          () => <div>Layout</div>,
          () => [
            path("/", () => <div>Home</div>, { name: "home" }),
            path("/about", () => <div>About</div>, { name: "about" }),
          ],
        ),
      ]);

      RSCRouterContext.run(
        {
          manifest,
          patterns,
          namespace: "test",
          parent: null,
          counters: {},
        },
        () => urlPatterns.handler(),
      );

      expect(manifest.has("home")).toBe(true);
      expect(manifest.has("about")).toBe(true);
    });
  });

  describe("trailingSlash option", () => {
    it("should store trailingSlash config in context", () => {
      const manifest = new Map();
      const patterns = new Map();
      const trailingSlash = new Map<string, "always" | "never" | "ignore">();

      const urlPatterns = urls(({ path }) => [
        path("/ts-always", () => <div>Always</div>, {
          name: "tsAlways",
          trailingSlash: "always",
        }),
        path("/ts-never", () => <div>Never</div>, {
          name: "tsNever",
          trailingSlash: "never",
        }),
        path("/ts-ignore", () => <div>Ignore</div>, {
          name: "tsIgnore",
          trailingSlash: "ignore",
        }),
      ]);

      RSCRouterContext.run(
        {
          manifest,
          patterns,
          trailingSlash,
          namespace: "test",
          parent: null,
          counters: {},
        },
        () => urlPatterns.handler(),
      );

      expect(trailingSlash.get("tsAlways")).toBe("always");
      expect(trailingSlash.get("tsNever")).toBe("never");
      expect(trailingSlash.get("tsIgnore")).toBe("ignore");
    });
  });

  describe("include() helper", () => {
    it("should return IncludeItem with correct structure (always lazy)", () => {
      const blogPatterns = urls(({ path }) => [
        path("/", () => <div>Blog Index</div>, { name: "index" }),
      ]);

      // Verify include() returns the right structure directly
      const manifest = new Map();
      const patterns = new Map();

      RSCRouterContext.run(
        {
          manifest,
          patterns,
          namespace: "test",
          parent: null,
          counters: {},
        },
        () => {
          // Test include() directly within context
          const urlPatterns = urls(({ include }) => {
            const includeItem = include("/blog", blogPatterns, {
              name: "blog",
            }) as IncludeItem & {
              lazy: boolean;
              _lazyContext: any;
            };

            // Verify include item structure
            expect(includeItem.type).toBe("include");
            expect(includeItem.prefix).toBe("/blog");
            expect(includeItem.options?.name).toBe("blog");
            expect(includeItem.patterns).toBe(blogPatterns);

            // All includes are lazy by default
            expect(includeItem.lazy).toBe(true);
            expect(includeItem._lazyContext).toBeDefined();

            return [includeItem];
          });

          // Execute handler to verify it doesn't throw
          urlPatterns.handler();
        },
      );
    });

    it("should NOT register routes until include is evaluated (lazy behavior)", () => {
      const blogPatterns = urls(({ path }) => [
        path("/", () => <div>Blog Index</div>, { name: "index" }),
        path("/post", () => <div>Post</div>, { name: "post" }),
      ]);

      const manifest = new Map<string, EntryData>();
      const patterns = new Map<string, string>();

      let capturedInclude: IncludeItem | undefined;

      RSCRouterContext.run(
        {
          manifest,
          patterns,
          namespace: "test",
          parent: null,
          counters: {},
        },
        () => {
          const urlPatterns = urls(({ include }) => [
            include("/blog", blogPatterns, { name: "blog" }),
          ]);

          const items = urlPatterns.handler();
          capturedInclude = items[0] as IncludeItem;
        },
      );

      // Before evaluation: routes should NOT be in manifest
      expect(manifest.has("blog.index")).toBe(false);
      expect(manifest.has("blog.post")).toBe(false);
      expect(manifest.size).toBe(0);

      // After evaluation: routes should be in manifest
      evaluateLazyInclude(capturedInclude!, manifest, patterns);

      expect(manifest.has("blog.index")).toBe(true);
      expect(manifest.has("blog.post")).toBe(true);
      expect(manifest.size).toBe(2);
    });

    it("should apply URL prefix to nested patterns when evaluated", () => {
      const blogPatterns = urls(({ path }) => [
        path("/", () => <div>Blog Index</div>, { name: "index" }),
        path("/:slug", () => <div>Blog Post</div>, { name: "post" }),
      ]);

      const manifest = new Map<string, EntryData>();
      const patterns = new Map<string, string>();

      let capturedInclude: IncludeItem | undefined;

      RSCRouterContext.run(
        {
          manifest,
          patterns,
          namespace: "test",
          parent: null,
          counters: {},
        },
        () => {
          const urlPatterns = urls(({ include }) => [
            include("/blog", blogPatterns, { name: "blog" }),
          ]);

          const items = urlPatterns.handler();
          // Capture the lazy include item
          capturedInclude = items[0] as IncludeItem;
        },
      );

      // Routes should NOT be registered yet (lazy)
      expect(manifest.has("blog.index")).toBe(false);
      expect(manifest.has("blog.post")).toBe(false);

      // Now simulate router evaluating the lazy include
      evaluateLazyInclude(capturedInclude!, manifest, patterns);

      // Routes should now be prefixed with "blog."
      expect(manifest.has("blog.index")).toBe(true);
      expect(manifest.has("blog.post")).toBe(true);

      // Patterns should be prefixed with "/blog"
      expect(patterns.get("blog.index")).toBe("/blog");
      expect(patterns.get("blog.post")).toBe("/blog/:slug");
    });

    it("should apply name prefix to nested route names when evaluated", () => {
      const shopPatterns = urls(({ path }) => [
        path("/", () => <div>Shop</div>, { name: "index" }),
        path("/cart", () => <div>Cart</div>, { name: "cart" }),
        path("/product/:id", () => <div>Product</div>, { name: "product" }),
      ]);

      const manifest = new Map<string, EntryData>();
      const patterns = new Map<string, string>();

      let capturedInclude: IncludeItem | undefined;

      RSCRouterContext.run(
        {
          manifest,
          patterns,
          namespace: "test",
          parent: null,
          counters: {},
        },
        () => {
          const urlPatterns = urls(({ include }) => [
            include("/shop", shopPatterns, { name: "shop" }),
          ]);

          const items = urlPatterns.handler();
          capturedInclude = items[0] as IncludeItem;
        },
      );

      // Simulate router evaluating the lazy include
      evaluateLazyInclude(capturedInclude!, manifest, patterns);

      // All route names should be prefixed with "shop."
      expect(manifest.has("shop.index")).toBe(true);
      expect(manifest.has("shop.cart")).toBe(true);
      expect(manifest.has("shop.product")).toBe(true);

      // URL patterns should be prefixed with "/shop"
      expect(patterns.get("shop.cart")).toBe("/shop/cart");
      expect(patterns.get("shop.product")).toBe("/shop/product/:id");
    });

    it("should keep child route names under an internal scope when parent include has no name", () => {
      const adminPatterns = urls(({ path }) => [
        path("/", () => <div>Admin</div>, { name: "index" }),
        path("/users", () => <div>Users</div>, { name: "users" }),
      ]);

      const manifest = new Map<string, EntryData>();
      const patterns = new Map<string, string>();

      let capturedInclude: IncludeItem | undefined;

      RSCRouterContext.run(
        {
          manifest,
          patterns,
          namespace: "test",
          parent: null,
          counters: {},
        },
        () => {
          const urlPatterns = urls(({ include }) => [
            // No name option - routes stay local to the included module
            include("/admin", adminPatterns),
          ]);

          const items = urlPatterns.handler();
          capturedInclude = items[0] as IncludeItem;
        },
      );

      // Simulate router evaluating the lazy include
      evaluateLazyInclude(capturedInclude!, manifest, patterns);

      // Without an include name, child routes live under a hidden runtime scope.
      expect(manifest.has("$prefix_0.index")).toBe(true);
      expect(manifest.has("$prefix_0.users")).toBe(true);
      expect(manifest.has("index")).toBe(false);
      expect(manifest.has("users")).toBe(false);
      expect(manifest.has("admin.index")).toBe(false);
      expect(manifest.has("admin.users")).toBe(false);

      // But URL patterns should still be prefixed
      expect(patterns.get("$prefix_0.index")).toBe("/admin");
      expect(patterns.get("$prefix_0.users")).toBe("/admin/users");
    });

    it('should flatten child route names when include() uses { name: "" }', () => {
      const adminPatterns = urls(({ path }) => [
        path("/", () => <div>Admin</div>, { name: "index" }),
        path("/users", () => <div>Users</div>, { name: "users" }),
      ]);

      const manifest = new Map<string, EntryData>();
      const patterns = new Map<string, string>();

      let capturedInclude: IncludeItem | undefined;

      RSCRouterContext.run(
        {
          manifest,
          patterns,
          namespace: "test",
          parent: null,
          counters: {},
        },
        () => {
          const urlPatterns = urls(({ include }) => [
            include("/admin", adminPatterns, { name: "" }),
          ]);

          const items = urlPatterns.handler();
          capturedInclude = items[0] as IncludeItem;
        },
      );

      evaluateLazyInclude(capturedInclude!, manifest, patterns);

      expect(manifest.has("index")).toBe(true);
      expect(manifest.has("users")).toBe(true);
      expect(manifest.has("$prefix_0.index")).toBe(false);
      expect(patterns.get("index")).toBe("/admin");
      expect(patterns.get("users")).toBe("/admin/users");
    });

    it("should support nested includes when evaluated", () => {
      const postPatterns = urls(({ path }) => [
        path("/", () => <div>Posts</div>, { name: "index" }),
        path("/:id", () => <div>Post</div>, { name: "detail" }),
      ]);

      const blogPatterns = urls(({ path, include }) => [
        path("/", () => <div>Blog</div>, { name: "home" }),
        include("/posts", postPatterns, { name: "posts" }),
      ]);

      const manifest = new Map<string, EntryData>();
      const patterns = new Map<string, string>();

      let capturedBlogInclude: IncludeItem | undefined;

      RSCRouterContext.run(
        {
          manifest,
          patterns,
          namespace: "test",
          parent: null,
          counters: {},
        },
        () => {
          const urlPatterns = urls(({ include }) => [
            include("/blog", blogPatterns, { name: "blog" }),
          ]);

          const items = urlPatterns.handler();
          capturedBlogInclude = items[0] as IncludeItem;
        },
      );

      // Evaluate outer include (blog) - this will register blog.home and return nested posts include
      const blogItems = evaluateLazyInclude(
        capturedBlogInclude!,
        manifest,
        patterns,
      );

      // Top level blog routes should be registered
      expect(manifest.has("blog.home")).toBe(true);
      expect(patterns.get("blog.home")).toBe("/blog");

      // Get the nested posts include from the returned items
      const capturedPostsInclude = blogItems.find(
        (item: any) => item?.type === "include",
      ) as IncludeItem | undefined;

      // Evaluate nested posts include
      if (capturedPostsInclude) {
        evaluateLazyInclude(capturedPostsInclude, manifest, patterns);
      }

      // Nested posts routes (blog.posts.index, blog.posts.detail)
      expect(manifest.has("blog.posts.index")).toBe(true);
      expect(manifest.has("blog.posts.detail")).toBe(true);
      expect(patterns.get("blog.posts.index")).toBe("/blog/posts");
      expect(patterns.get("blog.posts.detail")).toBe("/blog/posts/:id");
    });

    it("should reuse same patterns with different prefixes when evaluated", () => {
      // Same pattern module can be included multiple times with different prefixes
      const contentPatterns = urls(({ path }) => [
        path("/", () => <div>Index</div>, { name: "index" }),
        path("/:slug", () => <div>Detail</div>, { name: "detail" }),
      ]);

      const manifest = new Map<string, EntryData>();
      const patterns = new Map<string, string>();

      let capturedIncludes: IncludeItem[] = [];

      RSCRouterContext.run(
        {
          manifest,
          patterns,
          namespace: "test",
          parent: null,
          counters: {},
        },
        () => {
          const urlPatterns = urls(({ include }) => [
            include("/blog", contentPatterns, { name: "blog" }),
            include("/news", contentPatterns, { name: "news" }),
          ]);

          const items = urlPatterns.handler();
          capturedIncludes = items as IncludeItem[];
        },
      );

      // Evaluate both includes
      for (const includeItem of capturedIncludes) {
        evaluateLazyInclude(includeItem, manifest, patterns);
      }

      // Both should have their own prefixed routes
      expect(manifest.has("blog.index")).toBe(true);
      expect(manifest.has("blog.detail")).toBe(true);
      expect(manifest.has("news.index")).toBe(true);
      expect(manifest.has("news.detail")).toBe(true);

      // With different URL prefixes
      expect(patterns.get("blog.index")).toBe("/blog");
      expect(patterns.get("news.index")).toBe("/news");
      expect(patterns.get("blog.detail")).toBe("/blog/:slug");
      expect(patterns.get("news.detail")).toBe("/news/:slug");
    });
  });

  // -----------------------------------------------------------------------
  // Include scoping contract
  // -----------------------------------------------------------------------

  describe("include scoping contract", () => {
    it("include() without name creates local-only scope — children not exported globally", () => {
      const childPatterns = urls(({ path }) => [
        path("/", () => <div>Child Index</div>, { name: "child" }),
        path("/detail", () => <div>Child Detail</div>, { name: "detail" }),
      ]);

      const manifest = new Map<string, EntryData>();
      const patterns = new Map<string, string>();
      let captured: IncludeItem | undefined;

      RSCRouterContext.run(
        { manifest, patterns, namespace: "test", parent: null, counters: {} },
        () => {
          const p = urls(({ include }) => [include("/x", childPatterns)]);
          captured = p.handler()[0] as IncludeItem;
        },
      );

      evaluateLazyInclude(captured!, manifest, patterns);

      // Children live under hidden $prefix_N scope
      expect(manifest.has("$prefix_0.child")).toBe(true);
      expect(manifest.has("$prefix_0.detail")).toBe(true);
      // NOT exported with flat names
      expect(manifest.has("child")).toBe(false);
      expect(manifest.has("detail")).toBe(false);
    });

    it('include() with { name: "" } flattens children into parent scope', () => {
      const childPatterns = urls(({ path }) => [
        path("/", () => <div>Child</div>, { name: "child" }),
        path("/detail", () => <div>Detail</div>, { name: "detail" }),
      ]);

      const manifest = new Map<string, EntryData>();
      const patterns = new Map<string, string>();
      let captured: IncludeItem | undefined;

      RSCRouterContext.run(
        { manifest, patterns, namespace: "test", parent: null, counters: {} },
        () => {
          const p = urls(({ include }) => [
            include("/x", childPatterns, { name: "" }),
          ]);
          captured = p.handler()[0] as IncludeItem;
        },
      );

      evaluateLazyInclude(captured!, manifest, patterns);

      // Children are globally visible
      expect(manifest.has("child")).toBe(true);
      expect(manifest.has("detail")).toBe(true);
      // Not under hidden scope
      expect(manifest.has("$prefix_0.child")).toBe(false);
      expect(patterns.get("child")).toBe("/x");
      expect(patterns.get("detail")).toBe("/x/detail");
    });

    it('include() with { name: "foo" } prefixes children as foo.child', () => {
      const childPatterns = urls(({ path }) => [
        path("/", () => <div>Child</div>, { name: "child" }),
        path("/detail", () => <div>Detail</div>, { name: "detail" }),
      ]);

      const manifest = new Map<string, EntryData>();
      const patterns = new Map<string, string>();
      let captured: IncludeItem | undefined;

      RSCRouterContext.run(
        { manifest, patterns, namespace: "test", parent: null, counters: {} },
        () => {
          const p = urls(({ include }) => [
            include("/x", childPatterns, { name: "foo" }),
          ]);
          captured = p.handler()[0] as IncludeItem;
        },
      );

      evaluateLazyInclude(captured!, manifest, patterns);

      // Children prefixed with foo.
      expect(manifest.has("foo.child")).toBe(true);
      expect(manifest.has("foo.detail")).toBe(true);
      // Not flat or hidden
      expect(manifest.has("child")).toBe(false);
      expect(manifest.has("$prefix_0.child")).toBe(false);
      expect(patterns.get("foo.child")).toBe("/x");
      expect(patterns.get("foo.detail")).toBe("/x/detail");
    });

    it('{ name: "" } + nested { name: "sub" } registers routes as root-scoped', () => {
      const subPatterns = urls(({ path }) => [
        path("/", () => <div>Sub Index</div>, { name: "index" }),
        path("/:id", () => <div>Sub Detail</div>, { name: "detail" }),
      ]);

      const modulePatterns = urls(({ path, include }) => [
        path("/", () => <div>Module Index</div>, { name: "modIndex" }),
        include("/sub", subPatterns, { name: "sub" }),
      ]);

      const manifest = new Map<string, EntryData>();
      const patterns = new Map<string, string>();
      let captured: IncludeItem | undefined;

      RSCRouterContext.run(
        { manifest, patterns, namespace: "test", parent: null, counters: {} },
        () => {
          const p = urls(({ include }) => [
            include("/flat", modulePatterns, { name: "" }),
          ]);
          captured = p.handler()[0] as IncludeItem;
        },
      );

      const moduleItems = evaluateLazyInclude(captured!, manifest, patterns);

      // Evaluate the nested sub include
      const subInclude = moduleItems.find(
        (item: any) => item?.type === "include",
      ) as IncludeItem | undefined;
      if (subInclude) {
        evaluateLazyInclude(subInclude, manifest, patterns);
      }

      // Bare route from { name: "" } mount
      expect(manifest.has("modIndex")).toBe(true);
      expect(isRouteRootScoped("modIndex")).toBe(true);

      // Dotted routes from nested { name: "sub" } inside { name: "" }
      expect(manifest.has("sub.index")).toBe(true);
      expect(manifest.has("sub.detail")).toBe(true);
      expect(isRouteRootScoped("sub.index")).toBe(true);
      expect(isRouteRootScoped("sub.detail")).toBe(true);
    });

    it('{ name: "ns" } registers routes as NOT root-scoped', () => {
      const childPatterns = urls(({ path }) => [
        path("/", () => <div>Child</div>, { name: "child" }),
      ]);

      const manifest = new Map<string, EntryData>();
      const patterns = new Map<string, string>();
      let captured: IncludeItem | undefined;

      RSCRouterContext.run(
        { manifest, patterns, namespace: "test", parent: null, counters: {} },
        () => {
          const p = urls(({ include }) => [
            include("/x", childPatterns, { name: "ns" }),
          ]);
          captured = p.handler()[0] as IncludeItem;
        },
      );

      evaluateLazyInclude(captured!, manifest, patterns);

      expect(manifest.has("ns.child")).toBe(true);
      expect(isRouteRootScoped("ns.child")).toBe(false);
    });

    it('{ name: "ns" } + nested { name: "sub" } stays NOT root-scoped', () => {
      const subPatterns = urls(({ path }) => [
        path("/", () => <div>Sub</div>, { name: "child" }),
      ]);

      const nsPatterns = urls(({ path, include }) => [
        path("/", () => <div>NS</div>, { name: "index" }),
        include("/sub", subPatterns, { name: "sub" }),
      ]);

      const manifest = new Map<string, EntryData>();
      const patterns = new Map<string, string>();
      let captured: IncludeItem | undefined;

      RSCRouterContext.run(
        { manifest, patterns, namespace: "test", parent: null, counters: {} },
        () => {
          const p = urls(({ include }) => [
            include("/x", nsPatterns, { name: "ns" }),
          ]);
          captured = p.handler()[0] as IncludeItem;
        },
      );

      const nsItems = evaluateLazyInclude(captured!, manifest, patterns);
      const subInclude = nsItems.find(
        (item: any) => item?.type === "include",
      ) as IncludeItem | undefined;
      if (subInclude) {
        evaluateLazyInclude(subInclude, manifest, patterns);
      }

      expect(manifest.has("ns.index")).toBe(true);
      expect(isRouteRootScoped("ns.index")).toBe(false);
      expect(manifest.has("ns.sub.child")).toBe(true);
      expect(isRouteRootScoped("ns.sub.child")).toBe(false);
    });

    it("multiple unnamed includes get distinct scopes", () => {
      const aPatterns = urls(({ path }) => [
        path("/", () => <div>A</div>, { name: "index" }),
      ]);
      const bPatterns = urls(({ path }) => [
        path("/", () => <div>B</div>, { name: "index" }),
      ]);

      const manifest = new Map<string, EntryData>();
      const patterns = new Map<string, string>();
      const captured: IncludeItem[] = [];

      RSCRouterContext.run(
        { manifest, patterns, namespace: "test", parent: null, counters: {} },
        () => {
          const p = urls(({ include }) => [
            include("/a", aPatterns),
            include("/b", bPatterns),
          ]);
          const items = p.handler();
          captured.push(...(items as IncludeItem[]));
        },
      );

      for (const item of captured) {
        evaluateLazyInclude(item, manifest, patterns);
      }

      // Each unnamed include gets its own $prefix_N scope
      expect(manifest.has("$prefix_0.index")).toBe(true);
      expect(manifest.has("$prefix_1.index")).toBe(true);
      expect(patterns.get("$prefix_0.index")).toBe("/a");
      expect(patterns.get("$prefix_1.index")).toBe("/b");
      // No collisions
      expect(manifest.has("index")).toBe(false);
    });
  });

  describe("middleware wrapping", () => {
    let manifest: Map<string, EntryData>;
    let patterns: Map<string, string>;

    beforeEach(() => {
      manifest = new Map();
      patterns = new Map();
    });

    it("single-fn wrapping creates a layout entry with middleware attached", () => {
      const mwFn = async (_ctx: any, next: any) => {
        await next();
      };

      const urlPatterns = urls(({ path, middleware }) => [
        middleware(mwFn, () => [
          path("/guarded", () => <div>Guarded</div>, { name: "guarded" }),
        ]),
        path("/public", () => <div>Public</div>, { name: "public" }),
      ]);

      RSCRouterContext.run(
        {
          manifest,
          patterns,
          namespace: "test",
          parent: null,
          counters: {},
        },
        () => urlPatterns.handler(),
      );

      // Both routes registered
      expect(manifest.has("guarded")).toBe(true);
      expect(manifest.has("public")).toBe(true);

      // Guarded route has a layout parent with middleware
      const guardedEntry = manifest.get("guarded")!;
      expect(guardedEntry.parent).not.toBeNull();
      expect(guardedEntry.parent!.type).toBe("layout");
      expect(guardedEntry.parent!.middleware).toHaveLength(1);
      expect(guardedEntry.parent!.middleware[0]).toBe(mwFn);

      // Public route has no middleware on its parent
      const publicEntry = manifest.get("public")!;
      expect(publicEntry.parent?.middleware ?? []).toHaveLength(0);
    });

    it("array-fn wrapping attaches all middleware to the layout entry", () => {
      const mw1 = async (_ctx: any, next: any) => {
        await next();
      };
      const mw2 = async (_ctx: any, next: any) => {
        await next();
      };

      const urlPatterns = urls(({ path, middleware }) => [
        middleware([mw1, mw2], () => [
          path("/guarded", () => <div>Guarded</div>, { name: "guarded" }),
        ]),
      ]);

      RSCRouterContext.run(
        {
          manifest,
          patterns,
          namespace: "test",
          parent: null,
          counters: {},
        },
        () => urlPatterns.handler(),
      );

      const guardedEntry = manifest.get("guarded")!;
      expect(guardedEntry.parent).not.toBeNull();
      expect(guardedEntry.parent!.middleware).toHaveLength(2);
      expect(guardedEntry.parent!.middleware[0]).toBe(mw1);
      expect(guardedEntry.parent!.middleware[1]).toBe(mw2);
    });

    it("sibling middleware still attaches to existing parent", () => {
      const mwFn = async (_ctx: any, next: any) => {
        await next();
      };

      const urlPatterns = urls(({ path, layout, middleware }) => [
        layout(
          () => <div />,
          () => [
            middleware(mwFn),
            path("/page", () => <div>Page</div>, { name: "page" }),
          ],
        ),
      ]);

      RSCRouterContext.run(
        {
          manifest,
          patterns,
          namespace: "test",
          parent: null,
          counters: {},
        },
        () => urlPatterns.handler(),
      );

      const pageEntry = manifest.get("page")!;
      // The middleware is on the layout, which is the parent
      expect(pageEntry.parent).not.toBeNull();
      expect(pageEntry.parent!.type).toBe("layout");
      expect(pageEntry.parent!.middleware).toHaveLength(1);
      expect(pageEntry.parent!.middleware[0]).toBe(mwFn);
    });

    it("rejects variadic form middleware(fn1, fn2, fn3) with migration hint", () => {
      const mw1 = async (_ctx: any, next: any) => next();
      const mw2 = async (_ctx: any, next: any) => next();
      const mw3 = async (_ctx: any, next: any) => next();

      const urlPatterns = urls(({ path, middleware }) => [
        middleware(mw1 as any, mw2 as any, mw3 as any),
        path("/", () => <div />, { name: "home" }),
      ]);

      expect(() =>
        RSCRouterContext.run(
          {
            manifest,
            patterns,
            namespace: "test",
            parent: null,
            counters: {},
          },
          () => urlPatterns.handler(),
        ),
      ).toThrow(/middleware\(\[fn1, fn2/);
    });

    it("rejects legacy two-fn form middleware(fn1, fn2) with migration hint", () => {
      const mw1 = async (_ctx: any, next: any) => next();
      const mw2 = async (_ctx: any, next: any) => next();

      const urlPatterns = urls(({ path, middleware }) => [
        middleware(mw1 as any, mw2 as any),
        path("/", () => <div />, { name: "home" }),
      ]);

      expect(() =>
        RSCRouterContext.run(
          {
            manifest,
            patterns,
            namespace: "test",
            parent: null,
            counters: {},
          },
          () => urlPatterns.handler(),
        ),
      ).toThrow(/middleware\(\[fn1, fn2/);
    });
  });
});
