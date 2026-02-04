/**
 * Stress test URL patterns: 1500+ routes with complex patterns
 * - Root :locale param via include()
 * - Routes with params (/user/:id)
 * - Routes with optional params (/posts/:id?)
 * - Static flat routes
 * - Nested layouts
 * - API routes via include
 */
import { urls } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { includedPatterns } from "./included-patterns.js";
import { localizedPatterns } from "./localized-patterns.js";
import { HomePage } from "./pages/benchmark.js";

export const urlpatterns = urls(({ path, include }) => [
  // Home page (outside locale)
  path("/", HomePage, { name: "home" }),

  // === LOCALIZED ROUTES (1000+ under /:locale) ===
  include("/:locale", localizedPatterns, { name: "localized" }),

  // === API ROUTES (500) ===
  include("/api", includedPatterns, { name: "api" }),
]);
