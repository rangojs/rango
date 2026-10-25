import { createLoader } from "@rangojs/router";
import { readActionBoundaryCart } from "./action-boundary.store.js";

// Loaders only, so the client build gets id stubs for this module.

/** The layout's cart count, on the default revalidation. */
export const ActionBoundaryCartLoader = createLoader(async () =>
  readActionBoundaryCart(),
);
