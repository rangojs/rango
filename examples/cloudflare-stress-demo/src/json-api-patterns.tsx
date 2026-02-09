/**
 * JSON API response routes for PathResponse type testing.
 *
 * Uses urls.json() so handlers return plain objects auto-wrapped as JSON.
 * The response types are carried through to RegisteredRoutes via
 * MergeRoutesWithResponses, enabling PathResponse<"/json-api/health">
 * to resolve the correct data type.
 */
import { urls } from "@rangojs/router";

export const jsonApiPatterns = urls.json(({ path }) => [
  path("/health", (ctx) => ({
    status: "ok" as const,
    timestamp: Date.now(),
    uptime: process.uptime(),
  }), { name: "health" }),

  path("/stats", (ctx) => ({
    routes: 10000,
    prefixes: 3,
    lazy: true,
  }), { name: "stats" }),

  path("/items", (ctx) => ([
    { id: "1", name: "Widget", price: 9.99 },
    { id: "2", name: "Gadget", price: 19.99 },
  ]), { name: "items" }),

  path("/items/:id", (ctx) => ({
    id: ctx.params.id,
    name: `Item ${ctx.params.id}`,
    price: 9.99,
    inStock: true,
  }), { name: "item" }),
]);
