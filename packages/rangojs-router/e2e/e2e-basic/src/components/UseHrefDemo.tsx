"use client";

import { href } from "@rangojs/router/client";

/**
 * Demonstrates href() function for path-based URL resolution
 *
 * Shows path-based resolution (routes are mounted under the /app basename, so
 * href validates against the full, basename-prefixed paths):
 * 1. href("/app/about") -> "/app/about"
 * 2. href("/app/shop/cart") -> "/app/shop/cart"
 * 3. href("/app/blog/test") -> "/app/blog/test"
 */
export function UseHrefDemo() {
  return (
    <div data-testid="usehref-demo">
      <h2>href() Demo</h2>
      <ul>
        <li data-testid="href-path">
          Path-based: <code>href("/app/about")</code> →{" "}
          <span data-testid="href-path-result">{href("/app/about")}</span>
        </li>
        <li data-testid="href-absolute">
          Absolute path: <code>href("/app/shop/cart")</code> →{" "}
          <span data-testid="href-absolute-result">
            {href("/app/shop/cart")}
          </span>
        </li>
        <li data-testid="href-with-params">
          With params: <code>href("/app/blog/test")</code> →{" "}
          <span data-testid="href-params-result">{href("/app/blog/test")}</span>
        </li>
      </ul>
    </div>
  );
}
