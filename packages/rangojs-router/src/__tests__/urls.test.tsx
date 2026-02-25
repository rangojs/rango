import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { urls, type IncludeItem } from "../urls.js";
import {
  RSCRouterContext,
  runWithPrefixes,
  type EntryData,
} from "../server/context.js";

/**
 * Helper to simulate lazy include evaluation.
 * In the actual router, this happens when a request matches the include's prefix.
 * For testing, we manually trigger it by calling runWithPrefixes with the captured context.
 */
function evaluateLazyInclude(
  includeItem: IncludeItem & {
    _lazyContext?: { urlPrefix: string; namePrefix: string | undefined };
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

    it("should work without name prefix (routes keep local names) when evaluated", () => {
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
            // No name option - routes keep their local names
            include("/admin", adminPatterns),
          ]);

          const items = urlPatterns.handler();
          capturedInclude = items[0] as IncludeItem;
        },
      );

      // Simulate router evaluating the lazy include
      evaluateLazyInclude(capturedInclude!, manifest, patterns);

      // Routes should keep local names (no prefix)
      expect(manifest.has("index")).toBe(true);
      expect(manifest.has("users")).toBe(true);

      // But URL patterns should still be prefixed
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
});
