import { urls } from "@rangojs/router";
import { ReleasesPage } from "./releases-handler.js";

export const releasesPatterns = urls(({ path }) => [
  path("/", ReleasesPage, { name: "index" }),
]);
