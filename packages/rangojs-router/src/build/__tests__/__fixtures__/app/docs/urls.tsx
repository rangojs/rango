import { urls } from "@rangojs/router";
import { guidesUrls } from "./guides/urls.js";
const handler = () => null;
export const docsUrls = urls(({ path, include }) => [
  path("/:slug", handler, { name: "page" }),
  include("/guides", guidesUrls, { name: "guides" }),
]);
