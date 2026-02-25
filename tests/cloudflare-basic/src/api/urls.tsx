import { urls, RouterError } from "@rangojs/router";

/**
 * API routes using urls.json() - handlers return plain objects,
 * auto-wrapped as JSON responses by the framework.
 *
 * Handlers can still return Response directly for full control
 * (custom status codes, headers, etc.).
 *
 * JSON routes return a { data } | { error } envelope:
 * - Success: { data: T }
 * - Error: { error: { message, code?, type? } } with appropriate HTTP status
 */
const products = [
  { id: "1", name: "Widget", price: 9.99 },
  { id: "2", name: "Gadget", price: 19.99 },
  { id: "3", name: "Doohickey", price: 4.99 },
];

export const apiPatterns = urls(({ path }) => [
  path.json("/health", (ctx) => ({ status: "ok", timestamp: Date.now() }), {
    name: "health",
  }),

  path.json("/products", (ctx) => products, { name: "products" }),

  path.json(
    "/products/:id",
    (ctx) => {
      const product = products.find((p) => p.id === ctx.params.id);
      if (!product) {
        throw new RouterError(
          "NOT_FOUND",
          `Product ${ctx.params.id} not found`,
          { status: 404 },
        );
      }
      return {
        id: product.id,
        name: product.name,
        price: product.price,
        description: `Details for product ${product.id}`,
      };
    },
    { name: "productDetail" },
  ),
]);
