"use client";

import { useHref } from "@rangojs/router/client";

/**
 * Demonstrates useHref() hook for route name resolution
 *
 * Shows three resolution modes:
 * 1. Path-based: href("/about") → "/about"
 * 2. Absolute name: href("shop.cart") → "/shop/cart"
 * 3. Local name (context-aware): href("index") → depends on current route prefix
 */
export function UseHrefDemo() {
  const href = useHref();

  return (
    <div data-testid="usehref-demo">
      <h2>useHref() Demo</h2>
      <ul>
        <li data-testid="href-path">
          Path-based: <code>href("/about")</code> → <span data-testid="href-path-result">{href("/about")}</span>
        </li>
        <li data-testid="href-absolute">
          Absolute name: <code>href("shop.cart")</code> → <span data-testid="href-absolute-result">{href("shop.cart")}</span>
        </li>
        <li data-testid="href-with-params">
          With params: <code>href("blog.post", {"{ slug: 'test' }"})</code> → <span data-testid="href-params-result">{href("blog.post", { slug: "test" })}</span>
        </li>
      </ul>
    </div>
  );
}
