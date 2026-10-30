import { urls } from "@rangojs/router";

const handler = () => null;
export const shopUrls = urls(({ path }) => [
  path("/shop", handler, { name: "shop" }),
  path("/shop/:id", handler, { name: "product" }),
]);
