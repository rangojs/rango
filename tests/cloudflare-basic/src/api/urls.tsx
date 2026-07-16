import { urls, RouterError, updateTag } from "@rangojs/router";
import { CACHE_LAB_ALLOWED_TAGS } from "../cache-lab-contract.js";

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
    "/cache/invalidate",
    async (ctx) => {
      ctx.header("Cache-Control", "no-store");

      if (ctx.request.method !== "POST") {
        return Response.json(
          { error: "Use POST to invalidate cache tags." },
          { status: 405, headers: { Allow: "POST" } },
        );
      }

      let payload: unknown;
      try {
        payload = await ctx.request.json();
      } catch {
        return Response.json(
          { error: "The request body must be valid JSON." },
          { status: 400 },
        );
      }

      const candidateTags =
        typeof payload === "object" &&
        payload !== null &&
        "tags" in payload &&
        Array.isArray(payload.tags)
          ? payload.tags
          : null;
      if (
        !candidateTags ||
        candidateTags.length === 0 ||
        candidateTags.length > CACHE_LAB_ALLOWED_TAGS.length ||
        !candidateTags.every((tag): tag is string => typeof tag === "string")
      ) {
        return Response.json(
          { error: "tags must be a non-empty array of known cache tags." },
          { status: 400 },
        );
      }

      const tags = [...new Set(candidateTags)];
      const unknownTags = tags.filter(
        (tag) => !CACHE_LAB_ALLOWED_TAGS.includes(tag),
      );
      if (unknownTags.length > 0) {
        return Response.json(
          { error: `Unknown cache tag: ${unknownTags.join(", ")}` },
          { status: 400 },
        );
      }

      await updateTag(...tags);
      return { invalidated: tags };
    },
    { name: "cacheInvalidate" },
  ),

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
