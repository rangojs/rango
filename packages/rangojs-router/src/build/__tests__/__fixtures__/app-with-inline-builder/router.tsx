import { createRouter } from "@rangojs/router";
import { apiUrls } from "./api/urls.js";
const handler = () => null;
export const router = createRouter().routes(({ path, include }) => [
  path("/", handler, { name: "home" }),
  path("/about", handler, { name: "about" }),
  include("/api", apiUrls, { name: "api" }),
]);
