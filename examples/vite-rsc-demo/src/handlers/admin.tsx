import { map } from "rsc-router/server";
import type { adminRoutes } from "../routes.js";
import { IndexRoute, UsersRoute, UserRoute, SettingsRoute } from "./admin/routes.js";
import { globalRevalidation, settingsRevalidation, userRevalidation } from "./admin/revalidation.js";

/**
 * Admin handlers - demonstrates soft/hard revalidation pattern
 *
 * KEY CONCEPTS:
 * - Soft decision: { defaultShouldRevalidate: boolean } - continues to next revalidator
 * - Hard decision: boolean - short-circuits immediately
 *
 * Array-based API with use() pattern
 * Note: RootLayout is now used as the document component in router.tsx
 */
export default map<typeof adminRoutes>(({ route, layout, revalidate }) => [
  // Global soft revalidation
  revalidate(globalRevalidation),

  route("index", IndexRoute),
  route("users", UsersRoute),

  route("user", UserRoute, () => [
    revalidate(userRevalidation),
  ]),

  route("settings", SettingsRoute, () => [
    revalidate(settingsRevalidation),
  ]),
]);
