import { createHandle, createLoader, urls } from "@rangojs/router";

// Evaluated at import: both throw without the $$id that the
// expose-internal-ids transform injects (outside a test runner).
export const ProductLoader = createLoader(async () => ({ name: "product" }));
export const Breadcrumbs = createHandle<string>();

const handler = () => null;
export const urlpatterns = urls(({ path, loader }) => [
  path("/", handler, { name: "home" }),
  path("/product/:id", handler, { name: "product" }, () => [
    loader(ProductLoader),
  ]),
]);
