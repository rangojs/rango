import { urls } from "@rangojs/router";
// Resolved only by the vite.config.ts resolver that initializes in
// configResolved.
import { MARKED_PATH } from "@config-resolved/marker";

const handler = () => null;
export const urlpatterns = urls(({ path }) => [
  path("/", handler, { name: "home" }),
  path(MARKED_PATH, handler, { name: "marked" }),
]);
