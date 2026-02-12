import { urls } from "@rangojs/router";
import { SearchIndexHandler, SearchDetailHandler } from "./search.handlers.js";

/**
 * Search URL patterns for testing typed search params
 * Routes: search.index (with search schema), search.detail (without search schema)
 */
export const searchPatterns = urls(({ path }) => [
  path("/", SearchIndexHandler, {
    name: "index",
    search: { q: "string", page: "number?", sort: "string?" },
  }),
  path("/:category", SearchDetailHandler, {
    name: "detail",
    search: { q: "string?", active: "boolean?" },
  }),
]);
