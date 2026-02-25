import { createReverse } from "@rangojs/router";
import type { RouteResponse, ExtractParams } from "@rangojs/router";
import { NamedRoutes } from "./router.named-routes.gen.js";
import type { apiShopPatterns } from "./urls/api-shop.js";

type CatalogResponse = RouteResponse<typeof apiShopPatterns, "catalog">;
type ProductResponse = RouteResponse<typeof apiShopPatterns, "product">;
type CartResponse = RouteResponse<typeof apiShopPatterns, "cart">;
type CartItemResponse = RouteResponse<typeof apiShopPatterns, "cartItem">;
type HealthResponse = RouteResponse<typeof apiShopPatterns, "health">;

type ProductParams = ExtractParams<(typeof NamedRoutes)["apiShop.product"]>;
type CartItemParams = ExtractParams<(typeof NamedRoutes)["apiShop.cartItem"]>;

const apiShopRoutes = {
  "apiShop.cart": NamedRoutes["apiShop.cart"],
  "apiShop.cartItem": NamedRoutes["apiShop.cartItem"],
  "apiShop.catalog": NamedRoutes["apiShop.catalog"],
  "apiShop.health": NamedRoutes["apiShop.health"],
  "apiShop.product": NamedRoutes["apiShop.product"],
} as const;

export function createShopClient(baseUrl: string) {
  const reverse = createReverse(apiShopRoutes);

  function url(
    name: keyof typeof apiShopRoutes,
    params?: Record<string, string>,
  ): string {
    const path = params
      ? (reverse as any)(name, params)
      : (reverse as any)(name);
    return `${baseUrl}${path}`;
  }

  async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
    const res = await fetch(input, init);
    return res.json() as Promise<T>;
  }

  return {
    getCatalog(): Promise<CatalogResponse> {
      return fetchJson(url("apiShop.catalog"));
    },

    getProduct(productId: string): Promise<ProductResponse> {
      return fetchJson(url("apiShop.product", { productId }));
    },

    getCart(): Promise<CartResponse> {
      return fetchJson(url("apiShop.cart"));
    },

    addToCart(productId: string, quantity?: number): Promise<CartResponse> {
      return fetchJson(url("apiShop.cart"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, quantity }),
      });
    },

    updateCartItem(
      itemId: string,
      updates: { quantity: number },
    ): Promise<CartItemResponse> {
      return fetchJson(url("apiShop.cartItem", { itemId }), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
    },

    replaceCartItem(
      itemId: string,
      data: { productId: string; quantity: number },
    ): Promise<CartItemResponse> {
      return fetchJson(url("apiShop.cartItem", { itemId }), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    },

    removeCartItem(itemId: string): Promise<CartItemResponse> {
      return fetchJson(url("apiShop.cartItem", { itemId }), {
        method: "DELETE",
      });
    },

    clearCart(): Promise<CartResponse> {
      return fetchJson(url("apiShop.cart"), {
        method: "DELETE",
      });
    },

    async checkHealth(): Promise<{ ok: boolean; status: number }> {
      const res = await fetch(url("apiShop.health"), { method: "HEAD" });
      return { ok: res.ok, status: res.status };
    },

    getHealth(): Promise<HealthResponse> {
      return fetchJson(url("apiShop.health"));
    },
  };
}
