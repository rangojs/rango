/**
 * Stress test URL patterns: 1500+ routes for benchmarking
 * - 500 flat routes at root
 * - 500 routes in nested layouts (5 levels × 100 each)
 * - 500 routes via include()
 */
import { urls } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { includedPatterns } from "./included-patterns.js";
import { HomePage } from "./pages/benchmark.js";

// Simple page component for stress routes
const StressPage = () => <div>Stress Route</div>;

// Simple layout wrapper - uses Outlet for children
const Layout = () => (
  <div>
    <Outlet />
  </div>
);

export const urlpatterns = urls(({ path, layout, include }) => [
  // Home page
  path("/", HomePage, { name: "home" }),

  // === FLAT ROUTES (500) ===
  ...Array.from({ length: 500 }, (_, i) =>
    path(`/flat/${i + 1}`, StressPage, { name: `flat${i + 1}` })
  ),

  // === NESTED LAYOUTS (500 routes across 5 levels) ===
  layout(<Layout />, () => [
    // Level 1: 100 routes
    ...Array.from({ length: 100 }, (_, i) =>
      path(`/l1/${i + 1}`, StressPage, { name: `l1_${i + 1}` })
    ),

    layout(<Layout />, () => [
      // Level 2: 100 routes
      ...Array.from({ length: 100 }, (_, i) =>
        path(`/l2/${i + 1}`, StressPage, { name: `l2_${i + 1}` })
      ),

      layout(<Layout />, () => [
        // Level 3: 100 routes
        ...Array.from({ length: 100 }, (_, i) =>
          path(`/l3/${i + 1}`, StressPage, { name: `l3_${i + 1}` })
        ),

        layout(<Layout />, () => [
          // Level 4: 100 routes
          ...Array.from({ length: 100 }, (_, i) =>
            path(`/l4/${i + 1}`, StressPage, { name: `l4_${i + 1}` })
          ),

          layout(<Layout />, () => [
            // Level 5: 100 routes (deepest)
            ...Array.from({ length: 100 }, (_, i) =>
              path(`/l5/${i + 1}`, StressPage, { name: `l5_${i + 1}` })
            ),
          ]),
        ]),
      ]),
    ]),
  ]),

  // === INCLUDED ROUTES (500) ===
  include("/included", includedPatterns, { name: "included" }),
]);
