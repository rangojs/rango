import { createReverse } from "@rangojs/router/server";
import type { RouteResponse, ExtractParams } from "@rangojs/router";
import { routes } from "./urls/api-shop.gen.js";
import type { apiShopPatterns } from "./urls/api-shop.js";

type CatalogResponse = RouteResponse<typeof apiShopPatterns, "catalog">;
type ProductResponse = RouteResponse<typeof apiShopPatterns, "product">;
type CartResponse = RouteResponse<typeof apiShopPatterns, "cart">;
type CartItemResponse = RouteResponse<typeof apiShopPatterns, "cartItem">;
type HealthResponse = RouteResponse<typeof apiShopPatterns, "health">;

type ProductParams = ExtractParams<(typeof routes)["product"]>;
type CartItemParams = ExtractParams<(typeof routes)["cartItem"]>;

export function createShopClient(baseUrl: string) {
  const reverse = createReverse(routes);

  function url(name: keyof typeof routes, params?: Record<string, string>): string {
    const path = params ? (reverse as any)(name, params) : (reverse as any)(name);
    return `${baseUrl}${path}`;
  }

  async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
    const res = await fetch(input, init);
    return res.json() as Promise<T>;
  }

  return {
    getCatalog(): Promise<CatalogResponse> {
      return fetchJson(url("catalog"));
    },

    getProduct(productId: string): Promise<ProductResponse> {
      return fetchJson(url("product", { productId }));
    },

    getCart(): Promise<CartResponse> {
      return fetchJson(url("cart"));
    },

    addToCart(productId: string, quantity?: number): Promise<CartResponse> {
      return fetchJson(url("cart"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, quantity }),
      });
    },

    updateCartItem(itemId: string, updates: { quantity: number }): Promise<CartItemResponse> {
      return fetchJson(url("cartItem", { itemId }), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
    },

    replaceCartItem(itemId: string, data: { productId: string; quantity: number }): Promise<CartItemResponse> {
      return fetchJson(url("cartItem", { itemId }), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    },

    removeCartItem(itemId: string): Promise<CartItemResponse> {
      return fetchJson(url("cartItem", { itemId }), {
        method: "DELETE",
      });
    },

    clearCart(): Promise<CartResponse> {
      return fetchJson(url("cart"), {
        method: "DELETE",
      });
    },

    async checkHealth(): Promise<{ ok: boolean; status: number }> {
      const res = await fetch(url("health"), { method: "HEAD" });
      return { ok: res.ok, status: res.status };
    },

    getHealth(): Promise<HealthResponse> {
      return fetchJson(url("health"));
    },
  };
}
