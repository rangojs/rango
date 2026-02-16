import { urls } from "@rangojs/router";
import { ThemeIndexHandler, ThemeToggleHandler } from "./theme.handlers.js";

/**
 * Theme test routes URL patterns
 * Routes: theme.index, theme.toggle
 */
export const themePatterns = urls(({ path }) => [
  path("/", ThemeIndexHandler, { name: "index" }),
  path("/toggle", ThemeToggleHandler, { name: "toggle" }),
]);
