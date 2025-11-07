/**
 * Minimal test setup for the new declarative router API
 * This is a simple example you can modify and experiment with
 */

import {
  createRouter,
  route,
  middleware,
  layout,
  revalidate,
  type RouteContext,
} from "rsc-router";

// ==========================================
// Step 1: Define your routes
// ==========================================

const routes = route({
  home: "/",
  about: "/about",
  test: {
    index: "/test",
    detail: "/test/:id",
    nested: {
      deep: "/test/nested/deep",
    }
  }
});

// ==========================================
// Step 2: Create the router
// ==========================================

export const router = createRouter(routes, {
  // Global middleware (optional)
  [middleware]: [
    async (ctx: RouteContext, next: () => Promise<void>) => {
      console.log(`[Test Router] Request to: ${ctx.pathname}`);
      await next();
    },
  ],
});

// ==========================================
// Step 3: Map handlers to routes
// ==========================================

// Map main routes
router.map(routes, {
  // Simple route handlers
  home: async () => (
    <div>
      <h1>Test Home Page</h1>
      <p>Welcome to the declarative router test!</p>
      <nav>
        <a href="/about">About</a> | <a href="/test">Test Section</a>
      </nav>
    </div>
  ),

  about: async () => (
    <div>
      <h1>About Page</h1>
      <p>This is a simple about page.</p>
      <a href="/">← Back Home</a>
    </div>
  ),

  // Nested routes with their own handlers
  test: {
    // Add a layout for all test routes
    [layout]: async () => (
      <div style={{ border: "2px solid blue", padding: "20px" }}>
        <h2>Test Layout</h2>
        <p>This blue border wraps all test pages</p>
        <hr />
        {/* The Outlet component will be injected here automatically */}
      </div>
    ),

    // Test middleware
    [middleware]: [
      async (ctx: RouteContext, next: () => Promise<void>) => {
        console.log("[Test Section] Middleware running");
        await next();
      },
    ],

    // Route handlers
    index: async () => (
      <div>
        <h3>Test Index</h3>
        <p>This is the test section index.</p>
        <nav>
          <a href="/test/123">Test Item 123</a> |
          <a href="/test/456">Test Item 456</a> |
          <a href="/test/nested/deep">Deep Nested</a>
        </nav>
      </div>
    ),

    detail: async (ctx: RouteContext) => {
      const { id } = ctx.params;
      return (
        <div>
          <h3>Test Detail Page</h3>
          <p>You are viewing test item: <strong>{id}</strong></p>
          <p>URL: {ctx.pathname}</p>
          <p>Search params: {ctx.searchParams.toString() || "none"}</p>
          <a href="/test">← Back to Test Index</a>
        </div>
      );
    },

    nested: {
      deep: async () => (
        <div>
          <h3>Deep Nested Page</h3>
          <p>This is a deeply nested route!</p>
          <p>Notice how the test layout is still applied.</p>
          <a href="/test">← Back to Test Index</a>
        </div>
      ),
    },
  },
});

// ==========================================
// Alternative: Lazy loading example
// ==========================================

// You could also lazy load handlers like this:
// router.map(routes.test, () => import("./test-handlers"));

// Then in test-handlers.ts:
/*
export default {
  [layout]: TestLayout,
  index: TestIndexPage,
  detail: TestDetailPage,
  nested: {
    deep: DeepNestedPage,
  }
};
*/

// ==========================================
// To use this router:
// ==========================================

// Replace the import in src/framework/entry.rsc.tsx:
// Change: import { router } from "../routes.tsx";
// To:     import { router } from "../routes.test.tsx";

export default router;