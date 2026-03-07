import { urls } from "@rangojs/router";

const handler = () => null;

export function createDocsPatterns() {
  return urls(({ path }) => [
    path("/", handler, { name: "index" }),
    path("/:slug", handler, { name: "page" }),
    // User-defined name containing "$" — must be preserved by the filter
    path("/admin", handler, { name: "$admin" }),
    // Unnamed route: no name option, generates a "$path_..." internal name at runtime
    path("/health", handler),
  ]);
}
