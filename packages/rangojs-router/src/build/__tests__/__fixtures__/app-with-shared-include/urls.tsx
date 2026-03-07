import { urls } from "@rangojs/router";
import { sharedUrls } from "./shared.js";
const handler = () => null;
export const urlpatterns = urls(({ path, include }) => [
  path("/", handler, { name: "home" }),
  include("/api", sharedUrls, { name: "api" }),
  include("/v2", sharedUrls, { name: "v2" }),
]);
