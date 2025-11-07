import { describe, it, expect, vi } from "vitest";
import {
  route,
  createRouter,
  middleware,
  layout,
  revalidate,
} from "./declarative";
import type { RouteContext, MiddlewareHandler } from "./types";

describe("Declarative Router API", () => {
  describe("route()", () => {
    it("should create a simple route map", () => {
      const routes = route({
        home: "/",
        about: "/about",
      });

      expect(routes).toEqual({
        home: "/",
        about: "/about",
      });
    });

    it("should handle nested route structures", () => {
      const routes = route({
        home: "/",
        blog: {
          index: "/",
          post: "/:slug",
        },
      });

      expect(routes.home).toBe("/");
      expect(routes.blog).toMatchObject({
        index: "/blog",
        post: "/blog/:slug",
      });
    });

    it("should merge multiple route maps", () => {
      const mainRoutes = route({
        home: "/",
        about: "/about",
      });

      const blogRoutes = route({
        index: "/",
        post: "/:slug",
      });

      const combined = route(mainRoutes, {
        blog: blogRoutes,
      });

      expect(combined).toMatchObject({
        home: "/",
        about: "/about",
        blog: {
          index: "/blog",
          post: "/blog/:slug",
        },
      });
    });

    it("should handle route definitions with methods", () => {
      const routes = route({
        contact: {
          get: {
            pattern: "/contact",
            method: "GET",
          },
          post: {
            pattern: "/contact",
            method: "POST",
          },
        },
      });

      // When patterns already include the segment, they're not duplicated
      expect(routes.contact.get).toMatchObject({
        pattern: "/contact",
        method: "GET",
      });
      expect(routes.contact.post).toMatchObject({
        pattern: "/contact",
        method: "POST",
      });
    });
  });

  describe("createRouter()", () => {
    it("should create a router instance", () => {
      const routes = route({
        home: "/",
      });

      const router = createRouter(routes);

      expect(router).toBeDefined();
      expect(router.map).toBeDefined();
      expect(router.match).toBeDefined();
      expect(router.matchPartial).toBeDefined();
    });

    it("should accept global middleware", () => {
      const routes = route({
        home: "/",
      });

      const globalMiddleware = vi.fn(async (_ctx, next) => {
        await next();
      });

      const router = createRouter(routes, {
        [middleware]: [globalMiddleware],
      });

      expect(router).toBeDefined();
    });
  });

  describe("router.map()", () => {
    it("should map handlers to routes", async () => {
      const routes = route({
        home: "/",
        about: "/about",
      });

      const router = createRouter(routes);

      const HomePage = () => <div>Home</div>;
      const AboutPage = () => <div>About</div>;

      router.map(routes, {
        home: async () => <HomePage />,
        about: async () => <AboutPage />,
      });

      // Router should accept the mapping without error
      expect(router).toBeDefined();
    });

    it("should support metadata symbols", () => {
      const routes = route({
        blog: {
          index: "/",
          post: "/:slug",
        },
      });

      const router = createRouter(routes);

      const BlogLayout = () => <div>Blog Layout</div>;
      const blogMiddleware: MiddlewareHandler = async (_ctx, next) => {
        await next();
      };

      router.map(routes, {
        blog: {
          [layout]: BlogLayout,
          [middleware]: [blogMiddleware],
          [revalidate]: {
            post: (_ctx) => true,
          },
          index: async () => <div>Blog Index</div>,
          post: async (_ctx) => <div>Blog Post</div>,
        },
      });

      expect(router).toBeDefined();
    });

    it("should support lazy loading handlers", () => {
      const routes = route({
        admin: {
          dashboard: "/",
          users: "/users",
        },
      });

      const router = createRouter(routes);

      // Mock lazy loading
      const lazyLoader = () =>
        Promise.resolve({
          default: {
            dashboard: async () => <div>Dashboard</div>,
            users: async () => <div>Users</div>,
          },
        });

      router.map(routes.admin, lazyLoader);

      expect(router).toBeDefined();
    });
  });

  describe("Request Matching", () => {
    it("should match simple routes", async () => {
      const routes = route({
        home: "/",
        about: "/about",
      });

      const router = createRouter(routes);

      const HomePage = () => <div>Home</div>;

      router.map(routes, {
        home: async () => <HomePage />,
        about: async () => <div>About</div>,
      });

      const request = new Request("http://localhost/");
      const [component] = await router.match(request);

      expect(component).toBeDefined();
    });

    it("should extract route parameters", async () => {
      const routes = route({
        post: "/posts/:id",
      });

      const router = createRouter(routes);

      let capturedParams: Record<string, string> = {};

      router.map(routes, {
        post: async (ctx: RouteContext) => {
          capturedParams = ctx.params;
          return <div>Post {ctx.params.id}</div>;
        },
      });

      const request = new Request("http://localhost/posts/123");
      await router.match(request);

      expect(capturedParams).toEqual({ id: "123" });
    });

    it("should handle nested route matching", async () => {
      const routes = route({
        blog: {
          index: "/",
          post: "/:slug",
          category: {
            index: "/category",
            detail: "/category/:name",
          },
        },
      });

      const router = createRouter(routes);

      let matchedRoute = "";

      router.map(routes, {
        blog: {
          index: async () => {
            matchedRoute = "blog-index";
            return <div>Blog Index</div>;
          },
          post: async (ctx: RouteContext) => {
            matchedRoute = `blog-post-${ctx.params.slug}`;
            return <div>Post</div>;
          },
          category: {
            index: async () => {
              matchedRoute = "category-index";
              return <div>Categories</div>;
            },
            detail: async (ctx: RouteContext) => {
              matchedRoute = `category-${ctx.params.name}`;
              return <div>Category</div>;
            },
          },
        },
      });

      // Test blog index
      await router.match(new Request("http://localhost/blog"));
      expect(matchedRoute).toBe("blog-index");

      // Test blog post
      await router.match(new Request("http://localhost/blog/my-post"));
      expect(matchedRoute).toBe("blog-post-my-post");

      // Test category
      await router.match(new Request("http://localhost/blog/category"));
      expect(matchedRoute).toBe("category-index");

      // Test category detail
      await router.match(new Request("http://localhost/blog/category/tech"));
      expect(matchedRoute).toBe("category-tech");
    });
  });

  describe("Middleware", () => {
    it("should execute middleware in order", async () => {
      const routes = route({
        test: "/test",
      });

      const router = createRouter(routes);
      const executionOrder: string[] = [];

      const middleware1: MiddlewareHandler = async (_ctx, next) => {
        executionOrder.push("middleware1-before");
        await next();
        executionOrder.push("middleware1-after");
      };

      const middleware2: MiddlewareHandler = async (_ctx, next) => {
        executionOrder.push("middleware2-before");
        await next();
        executionOrder.push("middleware2-after");
      };

      router.map(routes, {
        [middleware]: [middleware1, middleware2],
        test: async () => {
          executionOrder.push("handler");
          return <div>Test</div>;
        },
      });

      await router.match(new Request("http://localhost/test"));

      expect(executionOrder).toEqual([
        "middleware1-before",
        "middleware2-before",
        "handler",
        "middleware2-after",
        "middleware1-after",
      ]);
    });
  });

  describe("Partial Matching", () => {
    it("should support partial route matching", async () => {
      const routes = route({
        home: "/",
        about: "/about",
      });

      const router = createRouter(routes);

      router.map(routes, {
        home: async () => <div>Home</div>,
        about: async () => <div>About</div>,
      });

      const result = await router.matchPartial(
        new Request("http://localhost/about"),
        "/"
      );

      expect(result).toBeDefined();
      expect(result?.startIndex).toBeDefined();
      expect(result?.segments).toBeDefined();
    });
  });
});
