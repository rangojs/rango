import { urls } from "@rangojs/router";
const handler = () => null;
export const sharedUrls = urls(({ path }) => [
  path("/health", handler, { name: "health" }),
  path("/:id", handler, { name: "detail" }),
]);
