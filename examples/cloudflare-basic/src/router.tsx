import { createRSCRouter } from "@rangojs/router/server";
import { createDocumentCacheMiddleware } from "@rangojs/router/cache";
import { urlpatterns } from "./urls.js";
import { AppShell } from "./components/AppShell.js";
import type { AppEnv } from "./env.js";

// Create the router with document component
// AppShell wraps both route content and error boundaries,
// preventing the app shell from unmounting during errors (avoids FOUC)
export const router = createRSCRouter<AppEnv>({
  document: AppShell,
  // Enable theme support with system detection
  theme: {
    defaultTheme: "system",
    themes: ["light", "dark", "system"],
    attribute: "class",
    storageKey: "theme",
    enableSystem: true,
    enableColorScheme: true,
  },
})
  // Document cache middleware - caches full responses based on Cache-Control headers
  .use(createDocumentCacheMiddleware())
  // Register all routes
  .routes(urlpatterns);

type AppRoutes = typeof router.routeMap;

declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
  }
}
