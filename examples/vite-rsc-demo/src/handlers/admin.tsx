import { map } from "rsc-router";
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
 * Array-based API with nested structure
 */
export default map<typeof adminRoutes>(({ route, layout, revalidate }) => [
  layout(<RootLayout />, [
    // Global soft revalidation
    revalidate(globalRevalidation),

    route("index", IndexRoute),
    route("users", UsersRoute),

    route("user", UserRoute, ({ revalidate }) => [
      revalidate(userRevalidation),
    ]),

    route("settings", SettingsRoute, ({ revalidate }) => [
      revalidate(settingsRevalidation),
    ]),
  ]),
]);
