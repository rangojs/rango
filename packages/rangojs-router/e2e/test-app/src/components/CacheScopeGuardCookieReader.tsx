"use client";

import { useLoader } from "@rangojs/router/client";
import { CookieReaderLoader } from "../urls/cache-scope-guard-loader.js";

/**
 * Safe pattern for surfacing cookie-derived data inside a cache() boundary.
 *
 * The cookie value is read by a DSL loader (a fresh, never-cached segment) and
 * consumed here via useLoader(). The cached handler renders only this static
 * client-component shell — the session value rides the fresh loader segment, so
 * it reflects the CURRENT request's cookie and is never baked into the cached
 * output. Contrast with awaiting ctx.use(CookieReaderLoader) in the handler,
 * which would embed one visitor's cookie value into the shared cached shell.
 */
export function CacheScopeGuardCookieReader() {
  const { data } = useLoader(CookieReaderLoader);
  return (
    <span data-testid="csg-loader-cookies-value">
      {data?.session ?? "no-cookie"}
    </span>
  );
}
