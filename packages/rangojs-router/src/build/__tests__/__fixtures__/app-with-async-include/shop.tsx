import { urls } from "@rangojs/router";
const handler = () => null;

// Nested include INSIDE the async-imported module: the static resolver must
// recurse into it exactly as for an eager include, so shop.product.* names land
// in the manifest through the async parent.
export const productPatterns = urls(({ path }) => [
  path("/:id", handler, { name: "item" }),
]);

export const shopPatterns = urls(({ path, include }) => [
  path("/", handler, { name: "home" }),
  include("/product", productPatterns, { name: "product" }),
]);

// Convention for async includes: `export default urls(...)`.
export default shopPatterns;
