import { urls } from "@rangojs/router";
const handler = () => null;
// Async include: the route module is code-split behind `() => import()`. The
// static parser must resolve its `export default urls(...)` so href/named-route
// types still cover the split group (Finding 2).
export const urlpatterns = urls(({ path, include }) => [
  path("/", handler, { name: "home" }),
  include("/shop", () => import("./shop.js"), { name: "shop" }),
]);
