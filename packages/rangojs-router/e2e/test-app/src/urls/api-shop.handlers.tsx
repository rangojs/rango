import { RouterError } from "@rangojs/router";
import type { ResponseHandlerContext } from "@rangojs/router";

// -- Types --
// Using `type` (not `interface`) so values satisfy JsonValue's index signature.

type Product = {
  id: string;
  name: string;
  price: number;
  description: string;
};

type CartItem = {
  itemId: string;
  productId: string;
  quantity: number;
};

// -- In-memory store (resets on server restart) --

const products: Product[] = [
  { id: "p1", name: "Widget", price: 9.99, description: "A fine widget" },
  { id: "p2", name: "Gadget", price: 19.99, description: "A cool gadget" },
  { id: "p3", name: "Doohickey", price: 4.99, description: "A small doohickey" },
];

let cart: CartItem[] = [];
let nextItemId = 1;

// -- Handlers --
// Type annotations omitted; path.json() infers the correct types.

export function CatalogHandler(ctx: ResponseHandlerContext) {
  if (ctx.request.method !== "GET") {
    return new Response(null, { status: 405 });
  }
  return { products };
}

export function ProductHandler(ctx: ResponseHandlerContext<{ productId: string }>) {
  if (ctx.request.method !== "GET") {
    return new Response(null, { status: 405 });
  }
  const product = products.find((p) => p.id === ctx.params.productId);
  if (!product) {
    throw new RouterError("NOT_FOUND", `Product ${ctx.params.productId} not found`, { status: 404 });
  }
  return { product };
}

export async function CartHandler(ctx: ResponseHandlerContext) {
  const method = ctx.request.method;

  if (method === "GET") {
    return { items: cart };
  }

  if (method === "POST") {
    const body = (await ctx.request.json()) as { productId: string; quantity?: number };
    const product = products.find((p) => p.id === body.productId);
    if (!product) {
      throw new RouterError("NOT_FOUND", `Product ${body.productId} not found`, { status: 404 });
    }
    const item: CartItem = {
      itemId: String(nextItemId++),
      productId: body.productId,
      quantity: body.quantity ?? 1,
    };
    cart.push(item);
    return { items: cart, added: item };
  }

  if (method === "DELETE") {
    cart = [];
    return { cleared: true as const };
  }

  return new Response(null, { status: 405 });
}

export async function CartItemHandler(ctx: ResponseHandlerContext<{ itemId: string }>) {
  const method = ctx.request.method;
  const { itemId } = ctx.params;

  if (method === "GET") {
    const item = cart.find((i) => i.itemId === itemId);
    if (!item) {
      throw new RouterError("NOT_FOUND", `Cart item ${itemId} not found`, { status: 404 });
    }
    return { item };
  }

  if (method === "PATCH") {
    const item = cart.find((i) => i.itemId === itemId);
    if (!item) {
      throw new RouterError("NOT_FOUND", `Cart item ${itemId} not found`, { status: 404 });
    }
    const body = (await ctx.request.json()) as { quantity?: number };
    if (body.quantity !== undefined) {
      item.quantity = body.quantity;
    }
    return { item };
  }

  if (method === "PUT") {
    const idx = cart.findIndex((i) => i.itemId === itemId);
    if (idx === -1) {
      throw new RouterError("NOT_FOUND", `Cart item ${itemId} not found`, { status: 404 });
    }
    const body = (await ctx.request.json()) as { productId: string; quantity: number };
    cart[idx] = { itemId, productId: body.productId, quantity: body.quantity };
    return { item: cart[idx] };
  }

  if (method === "DELETE") {
    const idx = cart.findIndex((i) => i.itemId === itemId);
    if (idx === -1) {
      throw new RouterError("NOT_FOUND", `Cart item ${itemId} not found`, { status: 404 });
    }
    cart.splice(idx, 1);
    return { deleted: true as const, itemId };
  }

  return new Response(null, { status: 405 });
}

export function HealthHandler(ctx: ResponseHandlerContext) {
  const method = ctx.request.method;

  if (method === "GET" || method === "HEAD") {
    return { status: "ok" as const, timestamp: Date.now() };
  }

  return new Response(null, { status: 405 });
}
