/**
 * Complete test implementation of the declarative router API
 *
 * To use this router instead of the default one:
 * 1. Open src/framework/entry.rsc.tsx
 * 2. Change line 10 from:
 *    import { router } from "../routes.tsx";
 * 3. To:
 *    import { router } from "../routes.declarative-test.tsx";
 * 4. Save and the dev server will reload
 */

import {
  createRouter,
  route,
  middleware,
  layout,
  revalidate,
  type RouteContext,
  Outlet,
} from "rsc-router";

import {
  TestHomePage,
  TestItemList,
  TestItemDetail,
  TestCounter,
  TestLayout,
} from "./pages/TestPages";

// ==========================================
// STEP 1: Define route structure
// ==========================================

// Define test routes separately for modularity
const testRoutes = route({
  items: {
    index: "/items",
    detail: "/items/:id",
  },
  counter: "/counter",
});

// Define main routes and compose
const routes = route({
  home: "/",
  test: testRoutes, // Compose routes together!
});

// ==========================================
// STEP 2: Create router with global config
// ==========================================

const router = createRouter(routes, {
  // Global middleware that runs for ALL routes
  [middleware]: [
    async (ctx: RouteContext, next: () => Promise<void>) => {
      console.log(`[GLOBAL] ${ctx.request.method} ${ctx.pathname}`);
      console.log(`[GLOBAL] Search params:`, ctx.searchParams.toString());
      await next();
      console.log(`[GLOBAL] Response sent for ${ctx.pathname}`);
    },
  ],
});

// ==========================================
// STEP 3: Map handlers to routes
// ==========================================

// Map root-level routes
router.map(routes, {
  home: async () => <TestHomePage />,

  // Map test section with its own configuration
  test: {
    // Test section gets its own layout
    [layout]: async () => {
      // The layout wraps all child routes
      // The <Outlet /> component will be injected automatically
      return <TestLayout><Outlet /></TestLayout>;
    },

    // Test section middleware
    [middleware]: [
      async (ctx: RouteContext, next: () => Promise<void>) => {
        console.log(`[TEST SECTION] Accessing test route: ${ctx.pathname}`);
        await next();
      },
    ],

    // Revalidation configuration for test routes
    [revalidate]: {
      // Items list always revalidates
      items: {
        index: () => true,
        // Detail page only revalidates when ID changes
        detail: (ctx: any) => {
          console.log('[REVALIDATION] Checking if item detail should revalidate');
          console.log('  Current ID:', ctx.params.id);
          console.log('  Next ID:', ctx.actionParams?.id);
          return ctx.params.id !== ctx.actionParams?.id;
        },
      },
      // Counter always revalidates to show new timestamp
      counter: () => true,
    },

    // Route handlers for test section
    items: {
      index: async () => <TestItemList />,

      detail: async (ctx: RouteContext) => {
        const { id } = ctx.params;
        console.log(`[HANDLER] Rendering item detail for ID: ${id}`);
        return <TestItemDetail id={id} />;
      },
    },

    counter: async () => <TestCounter />,
  },
});

// ==========================================
// BONUS: 404 Handler
// ==========================================

// Add a catch-all 404 route
// Note: This would need special handling in the declarative API
// For now, the imperative router handles this in routes.tsx

// ==========================================
// EXPORTS
// ==========================================

export { router };
export default router;

// ==========================================
// FEATURES DEMONSTRATED
// ==========================================

/**
 * This test router demonstrates:
 *
 * 1. ✅ Declarative route definition with `route()`
 * 2. ✅ Route composition (testRoutes composed into main routes)
 * 3. ✅ Symbol-based metadata:
 *    - [middleware] for route-specific middleware
 *    - [layout] for persistent layouts
 *    - [revalidate] for fine-grained revalidation control
 * 4. ✅ Type-safe route parameters (ctx.params.id)
 * 5. ✅ Nested route structures
 * 6. ✅ Global and local middleware
 * 7. ✅ Layouts that persist across navigation
 * 8. ✅ Revalidation strategies per route
 *
 * TO TEST:
 * - Navigate between items and watch the layout persist
 * - Check console logs to see middleware execution
 * - Navigate between different item IDs to test revalidation
 * - Check the counter page to see server-side timestamps
 */