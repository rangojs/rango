import { createLoader } from "@rangojs/router";
import { readStaleDefaultsCart } from "./stale-defaults.store.js";

// Loaders only, so the client build gets id stubs for this module.

/** The layout's cart count. No revalidate(): the defaults decide. */
export const StaleDefaultsCartLoader = createLoader(async () =>
  readStaleDefaultsCart(),
);
