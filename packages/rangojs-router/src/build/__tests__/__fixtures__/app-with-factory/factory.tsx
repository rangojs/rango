import { urls } from "@rangojs/router";

const handler = () => null;

export function createDocsPatterns() {
  return urls(({ path }) => [
    path("/", handler, { name: "index" }),
    path("/:slug", handler, { name: "page" }),
  ]);
}
