"use client";

import { href, useHref, useMount, Link } from "@rangojs/router/client";

/**
 * Client component demonstrating href(), useHref(), and useMount()
 * with 14k+ routes for typecheck coverage.
 */
export function LinksDemo() {
  const mount = useMount();
  const localHref = useHref();

  // href() - absolute path validation against all 14k+ routes
  const homePath = href("/");
  const benchFirst = href("/bench/first");
  const benchLast = href("/bench/last");
  const linksPath = href("/links");
  const apiResource = href("/api/v1/resource1/123");
  const siteUser = href("/site/en/user1/456");
  const shopProduct = href("/shop/product/1");
  const shopCategory = href("/shop/category/1");

  // useHref() - mount-aware paths (at root mount, same as href)
  const localHome = localHref("/");
  const localLinks = localHref("/links");
  const localBench = localHref("/bench/first");

  return (
    <div>
      <h3>useMount()</h3>
      <p>
        Current mount prefix: <code>{mount || "(root)"}</code>
      </p>

      <h3>href() - Absolute Paths</h3>
      <ul>
        <li>
          /: <code>{homePath}</code>
        </li>
        <li>
          /bench/first: <code>{benchFirst}</code>
        </li>
        <li>
          /bench/last: <code>{benchLast}</code>
        </li>
        <li>
          /links: <code>{linksPath}</code>
        </li>
        <li>
          /api/v1/resource1/123: <code>{apiResource}</code>
        </li>
        <li>
          /site/en/user1/456: <code>{siteUser}</code>
        </li>
        <li>
          /shop/product/1: <code>{shopProduct}</code>
        </li>
        <li>
          /shop/category/1: <code>{shopCategory}</code>
        </li>
      </ul>

      <h3>useHref() - Mount-Aware Paths</h3>
      <ul>
        <li>
          / (local): <code>{localHome}</code>
        </li>
        <li>
          /links (local): <code>{localLinks}</code>
        </li>
        <li>
          /bench/first (local): <code>{localBench}</code>
        </li>
      </ul>

      <h3>Link Components</h3>
      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
        <Link to={homePath}>Home</Link>
        <Link to={linksPath}>Links Demo</Link>
        <Link to={benchFirst}>Bench First</Link>
        <Link to={shopProduct}>Shop Product 1</Link>
      </div>
    </div>
  );
}
