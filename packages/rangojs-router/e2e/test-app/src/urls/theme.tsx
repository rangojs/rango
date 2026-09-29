import { urls } from "@rangojs/router";
import {
  ThemeIndexHandler,
  ThemePprClientHandler,
  ThemePprHandler,
  ThemePprRequestContextHandler,
  ThemeToggleHandler,
} from "./theme.handlers.js";

/**
 * Theme test routes URL patterns
 * Routes: theme.index, theme.toggle, theme.ppr, theme.pprRc, theme.pprClient
 *
 * /ppr reads ctx.theme and /ppr-rc getRequestContext().theme on a ppr route:
 * the capture refuses (#971), so every visitor gets a MISS rendered with their
 * own theme. /ppr-client reads the theme with useTheme() instead and warms to
 * a HIT whose initialTheme is the no-cookie default.
 */
export const themePatterns = urls(({ path }) => [
  path("/", ThemeIndexHandler, { name: "index" }),
  path("/toggle", ThemeToggleHandler, { name: "toggle" }),
  path("/ppr", ThemePprHandler, { name: "ppr", ppr: true }),
  path("/ppr-rc", ThemePprRequestContextHandler, { name: "pprRc", ppr: true }),
  path("/ppr-client", ThemePprClientHandler, { name: "pprClient", ppr: true }),
]);
