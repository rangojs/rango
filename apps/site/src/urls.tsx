import { urls } from "@rangojs/router";
import { HomePage } from "./pages/home.js";
import { docsPatterns } from "./docs/urls.js";

export const urlpatterns = urls(({ path, include }) => [
  path("/", HomePage, { name: "home" }),
  include("/docs", docsPatterns, { name: "docs" }),
]);
