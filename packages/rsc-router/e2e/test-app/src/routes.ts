import { route } from "rsc-router/browser";

/**
 * Test app routes definition
 */
export const testRoutes = route({
  index: "/",
  product: {
    detail: "/product/:productId",
  },
});
