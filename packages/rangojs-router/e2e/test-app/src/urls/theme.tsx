import { urls } from "@rangojs/router";
import {
  ThemeDocCacheHandler,
  ThemeDocCacheLiveHandler,
  ThemeIndexHandler,
  ThemePprClientHandler,
  ThemePprHandler,
  ThemePprRequestContextHandler,
  ThemeToggleHandler,
} from "./theme.handlers.js";

/**
 * Theme test routes URL patterns
 * Routes: theme.index, theme.toggle, theme.ppr, theme.pprRc, theme.pprClient,
 * theme.docCache, theme.docCacheLive
 *
 * /ppr reads ctx.theme and /ppr-rc getRequestContext().theme on a ppr route:
 * the capture refuses (#971), so every visitor gets a MISS rendered with their
 * own theme. /ppr-client reads the theme with useTheme() instead and warms to
 * a HIT whose initialTheme is the no-cookie default.
 *
 * /doc-cache and /doc-cache/live run under the document-cache middleware
 * (router.tsx). /doc-cache sends s-maxage: its stored document carries the
 * no-cookie default as initialTheme, whoever stored it (#978). /doc-cache/live
 * sends none and keeps each visitor's theme.
 */
export const themePatterns = urls(({ path }) => [
  path("/", ThemeIndexHandler, { name: "index" }),
  path("/toggle", ThemeToggleHandler, { name: "toggle" }),
  path("/ppr", ThemePprHandler, { name: "ppr", ppr: true }),
  path("/ppr-rc", ThemePprRequestContextHandler, { name: "pprRc", ppr: true }),
  path("/ppr-client", ThemePprClientHandler, { name: "pprClient", ppr: true }),
  path("/doc-cache", ThemeDocCacheHandler, { name: "docCache" }),
  path("/doc-cache/live", ThemeDocCacheLiveHandler, { name: "docCacheLive" }),
]);
