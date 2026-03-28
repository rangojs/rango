import { createRouter } from "@rangojs/router";
import { apiUrls } from "./api/urls.js";
const handler = () => null;
export const router = createRouter({ basename: "/admin" }).routes(
  ({ path, include }) => [
    path("/", handler, { name: "home" }),
    path("/settings", handler, { name: "settings" }),
    include("/api", apiUrls, { name: "api" }),
  ],
);
