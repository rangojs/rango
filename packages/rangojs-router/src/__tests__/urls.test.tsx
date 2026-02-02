import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { urls } from "../urls.js";
import { RSCRouterContext, type EntryData } from "../server/context.js";

describe("urls()", () => {
  describe("basic structure", () => {
    it("should return UrlPatterns with handler function", () => {
      const patterns = urls(({ path }) => [
        path("/", () => <div>Home</div>),
      ]);

      expect(patterns.__brand).toBe("UrlPatterns");
      expect(typeof patterns.__handler).toBe("function");
    });

    it("should accept empty array", () => {
      const patterns = urls(() => []);

      expect(patterns.__brand).toBe("UrlPatterns");
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
        () => urlPatterns.__handler()
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
        () => urlPatterns.__handler()
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
        () => urlPatterns.__handler()
      );

      const entry = manifest.get("post");
      expect(entry).toBeDefined();
      expect((entry as any).pattern).toBe("/:slug");
    });

    it("should accept use callback as third argument", () => {
      const urlPatterns = urls(({ path, middleware }) => [
        path("/admin", () => <div>Admin</div>, () => [
          middleware(() => {}),
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
        () => urlPatterns.__handler()
      );

      // Should have a route registered
      expect(manifest.size).toBeGreaterThan(0);
    });

    it("should accept options and use callback", () => {
      const urlPatterns = urls(({ path, middleware }) => [
        path("/admin", () => <div>Admin</div>, { name: "admin" }, () => [
          middleware(() => {}),
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
        () => urlPatterns.__handler()
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
        layout(() => <div>Layout</div>, () => [
          path("/", () => <div>Home</div>, { name: "home" }),
          path("/about", () => <div>About</div>, { name: "about" }),
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
        () => urlPatterns.__handler()
      );

      expect(manifest.has("home")).toBe(true);
      expect(manifest.has("about")).toBe(true);
    });
  });

  describe("include() helper", () => {
    it("should return IncludeItem with correct structure", () => {
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
            const includeItem = include("/blog", blogPatterns, { name: "blog" });

            // Verify include item structure
            expect(includeItem.type).toBe("include");
            expect(includeItem.prefix).toBe("/blog");
            expect(includeItem.options?.name).toBe("blog");
            expect(includeItem.patterns).toBe(blogPatterns);

            return [includeItem];
          });

          // Execute handler to verify it doesn't throw
          urlPatterns.__handler();
        }
      );
    });

    it("should apply URL prefix to nested patterns", () => {
      const blogPatterns = urls(({ path }) => [
        path("/", () => <div>Blog Index</div>, { name: "index" }),
        path("/:slug", () => <div>Blog Post</div>, { name: "post" }),
      ]);

      const manifest = new Map<string, EntryData>();
      const patterns = new Map<string, string>();

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

          urlPatterns.__handler();
        }
      );

      // Routes should be prefixed with "blog."
      expect(manifest.has("blog.index")).toBe(true);
      expect(manifest.has("blog.post")).toBe(true);

      // Patterns should be prefixed with "/blog"
      expect(patterns.get("blog.index")).toBe("/blog");
      expect(patterns.get("blog.post")).toBe("/blog/:slug");
    });

    it("should apply name prefix to nested route names", () => {
      const shopPatterns = urls(({ path }) => [
        path("/", () => <div>Shop</div>, { name: "index" }),
        path("/cart", () => <div>Cart</div>, { name: "cart" }),
        path("/product/:id", () => <div>Product</div>, { name: "product" }),
      ]);

      const manifest = new Map<string, EntryData>();
      const patterns = new Map<string, string>();

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

          urlPatterns.__handler();
        }
      );

      // All route names should be prefixed with "shop."
      expect(manifest.has("shop.index")).toBe(true);
      expect(manifest.has("shop.cart")).toBe(true);
      expect(manifest.has("shop.product")).toBe(true);

      // URL patterns should be prefixed with "/shop"
      expect(patterns.get("shop.cart")).toBe("/shop/cart");
      expect(patterns.get("shop.product")).toBe("/shop/product/:id");
    });

    it("should work without name prefix (routes keep local names)", () => {
      const adminPatterns = urls(({ path }) => [
        path("/", () => <div>Admin</div>, { name: "index" }),
        path("/users", () => <div>Users</div>, { name: "users" }),
      ]);

      const manifest = new Map<string, EntryData>();
      const patterns = new Map<string, string>();

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

          urlPatterns.__handler();
        }
      );

      // Routes should keep local names (no prefix)
      expect(manifest.has("index")).toBe(true);
      expect(manifest.has("users")).toBe(true);

      // But URL patterns should still be prefixed
      expect(patterns.get("index")).toBe("/admin");
      expect(patterns.get("users")).toBe("/admin/users");
    });

    it("should support nested includes", () => {
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

          urlPatterns.__handler();
        }
      );

      // Top level blog routes
      expect(manifest.has("blog.home")).toBe(true);
      expect(patterns.get("blog.home")).toBe("/blog");

      // Nested posts routes (blog.posts.index, blog.posts.detail)
      expect(manifest.has("blog.posts.index")).toBe(true);
      expect(manifest.has("blog.posts.detail")).toBe(true);
      expect(patterns.get("blog.posts.index")).toBe("/blog/posts");
      expect(patterns.get("blog.posts.detail")).toBe("/blog/posts/:id");
    });

    it("should reuse same patterns with different prefixes", () => {
      // Same pattern module can be included multiple times with different prefixes
      const contentPatterns = urls(({ path }) => [
        path("/", () => <div>Index</div>, { name: "index" }),
        path("/:slug", () => <div>Detail</div>, { name: "detail" }),
      ]);

      const manifest = new Map<string, EntryData>();
      const patterns = new Map<string, string>();

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

          urlPatterns.__handler();
        }
      );

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
