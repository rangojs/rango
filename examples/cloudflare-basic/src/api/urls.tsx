import { urls, type ResponseHandlerContext } from "@rangojs/router/server";

/**
 * API routes using urls.JSON() - all routes return Response objects,
 * bypassing the RSC pipeline entirely.
 */
export const apiPatterns = urls.JSON(({ path }) => [
  path("/health", (ctx: ResponseHandlerContext) => {
    return Response.json({ status: "ok", timestamp: Date.now() });
  }, { name: "health" }),

  path("/products", (ctx: ResponseHandlerContext) => {
    const products = [
      { id: "1", name: "Widget", price: 9.99 },
      { id: "2", name: "Gadget", price: 19.99 },
      { id: "3", name: "Doohickey", price: 4.99 },
    ];
    return Response.json(products);
  }, { name: "products" }),

  path("/products/:id", (ctx: ResponseHandlerContext<{ id: string }>) => {
    const { id } = ctx.params;
    return Response.json({
      id,
      name: `Product ${id}`,
      price: 9.99,
      description: `Details for product ${id}`,
    });
  }, { name: "productDetail" }),
]);
