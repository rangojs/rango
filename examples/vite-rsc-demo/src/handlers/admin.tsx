import { map, layout, revalidateRoute } from "rsc-router";
import type { adminRoutes } from "../routes.js";
import { RootLayout } from "../layouts/RootLayout.js";
import { IndexRoute, UsersRoute, UserRoute, SettingsRoute } from "./admin/routes.js";
import { globalRevalidation, settingsRevalidation, userRevalidation } from "./admin/revalidation.js";

/**
 * Admin handlers - demonstrates soft/hard revalidation pattern
 *
 * KEY CONCEPTS:
 * - Soft decision: { defaultShouldRevalidate: boolean } - continues to next revalidator
 * - Hard decision: boolean - short-circuits immediately
 *
 * EXECUTION FLOW:
 * 1. Global revalidators provide soft defaults
 * 2. Route-specific can override with hard decisions
 * 3. If all soft → use final suggestion
 *
 * Now uses modular folder structure (routes/, revalidation/)
 */
export default map<typeof adminRoutes>({
  // Global layout
  [layout("*", "root")]: <RootLayout />,

  // SOFT REVALIDATION - Global Default
  [revalidateRoute("*", "global-default")]: globalRevalidation,

  // HARD REVALIDATION - Route-Specific Overrides
  [revalidateRoute("settings")]: settingsRevalidation,
  [revalidateRoute("user")]: userRevalidation,

  // ROUTE HANDLERS
  index: IndexRoute,
  users: UsersRoute,
  user: UserRoute,
  settings: SettingsRoute,
});
