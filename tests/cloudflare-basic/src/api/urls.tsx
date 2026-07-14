import { urls, RouterError } from "@rangojs/router";

/**
 * API routes using urls.json() - handlers return plain objects,
 * auto-wrapped as JSON responses by the framework.
 *
 * Handlers can still return Response directly for full control
 * (custom status codes, headers, etc.).
 *
 * JSON route wire format:
 * - Success: the bare handler value T, content-type application/json
 * - Error: an RFC 9457 problem+json object
 *   ({ type, title, status, detail, code }) with content-type
 *   application/problem+json and the appropriate HTTP status
 */
const products = [
  { id: "1", name: "Widget", price: 9.99 },
  { id: "2", name: "Gadget", price: 19.99 },
  { id: "3", name: "Doohickey", price: 4.99 },
];

export const apiPatterns = urls(({ path }) => [
  path.json(
    "/health",
    (ctx) => {
      if (ctx.url.searchParams.has("throw-response")) {
        ctx.header("X-Thrown-Response", "merged");
        throw Response.json(
          { status: "accepted", timestamp: Date.now() },
          { status: 202 },
        );
      }
      return { status: "ok", timestamp: Date.now() };
    },
    { name: "health" },
  ),

  path.json("/products", (ctx) => products, { name: "products" }),

  path.json(
    "/products/:id",
    async (ctx) => {
      if (
        import.meta.env.DEV &&
        ctx.url.searchParams.has("inject-diagnostic-failure")
      ) {
        const { injectDevelopmentDiagnosticFailureForTesting } =
          await import("@rangojs/router/internal/dev-diagnostics");
        injectDevelopmentDiagnosticFailureForTesting();
      }
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
