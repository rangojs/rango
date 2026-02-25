"use client";

import { href } from "@rangojs/router/client";

/**
 * Demonstrates href() function for path-based URL resolution
 *
 * Shows path-based resolution:
 * 1. href("/about") -> "/about"
 * 2. href("/shop/cart") -> "/shop/cart"
 * 3. href("/blog/test") -> "/blog/test"
 */
export function UseHrefDemo() {
  return (
    <div data-testid="usehref-demo">
      <h2>href() Demo</h2>
      <ul>
        <li data-testid="href-path">
          Path-based: <code>href("/about")</code> →{" "}
          <span data-testid="href-path-result">{href("/about")}</span>
        </li>
        <li data-testid="href-absolute">
          Absolute path: <code>href("/shop/cart")</code> →{" "}
          <span data-testid="href-absolute-result">{href("/shop/cart")}</span>
        </li>
        <li data-testid="href-with-params">
          With params: <code>href("/blog/test")</code> →{" "}
          <span data-testid="href-params-result">{href("/blog/test")}</span>
        </li>
      </ul>
    </div>
  );
}
