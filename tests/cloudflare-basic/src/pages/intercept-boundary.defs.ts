import { createLoader } from "@rangojs/router";
import { readInterceptBoundaryCart } from "./intercept-boundary.store.js";

// Loaders only, so the client build gets id stubs for this module.

/** The layout's cart count, on the default revalidation. */
export const InterceptBoundaryCartLoader = createLoader(async () =>
  readInterceptBoundaryCart(),
);
