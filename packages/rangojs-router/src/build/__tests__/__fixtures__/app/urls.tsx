import { urls } from "@rangojs/router";
import { apiUrls } from "./api/urls.js";
import { docsUrls } from "./docs/urls.js";
const handler = () => null;
export const urlpatterns = urls(({ path, include }) => [
  path("/", handler, { name: "home" }),
  path("/about", handler, { name: "about" }),
  include("/api", apiUrls, { name: "api" }),
  include("/docs", docsUrls, { name: "docs" }),
]);
