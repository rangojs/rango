"use client";

import { useCallback } from "react";
import type { LocalReverseFunction } from "../../reverse.js";
import { substitutePatternParams } from "../../router/substitute-pattern-params.js";
import { serializeSearchParams } from "../../search-params.js";
import { useMount } from "./use-mount.js";
import { useParams } from "./use-params.js";

type RouteEntry = string | { readonly path: string };
type LocalRouteMap = Readonly<Record<string, RouteEntry>>;

function getPattern(entry: RouteEntry | undefined): string | undefined {
  if (entry === undefined) return undefined;
  return typeof entry === "string" ? entry : entry.path;
}

/**
 * Join an include mount prefix with a mount-relative pattern.
 *
 * `pattern === "/"` is the index of the local module — under a non-root
 * mount it must collapse so `/` under `/blog` becomes `/blog`, not
 * `/blog/`. This matches `ctx.reverse(".index")` on the server.
 */
function joinMount(mount: string, pattern: string): string {
  if (pattern === "/") {
    if (mount === "" || mount === "/") return "/";
    return mount.endsWith("/") ? mount.slice(0, -1) : mount;
  }
  const normalizedMount = mount === "/" ? "" : mount.replace(/\/+$/, "");
  return normalizedMount + pattern;
}

/**
 * Mount-aware reverse function for a locally-imported `routes` map.
 *
 * Resolves dot-prefixed route names against the passed `routes` (typically
 * a generated `routes` from a `urls()` module's `.gen.ts`), prefixes the
 * result with the surrounding `include()` mount path, and substitutes
 * params — auto-filling from the current matched route's params and
 * letting explicit params override.
 *
 * @example
 * ```tsx
 * "use client";
 * import { Link, useReverse } from "@rangojs/router/client";
 * import { routes as blogRoutes } from "../urls/blog.gen.js";
 *
 * function BlogNav() {
 *   const reverse = useReverse(blogRoutes);
 *   return (
 *     <>
 *       <Link to={reverse(".index")}>Blog</Link>
 *       <Link to={reverse(".post", { postId: "hello" })}>Post</Link>
 *     </>
 *   );
 * }
 * ```
 */
export function useReverse<const TRoutes extends LocalRouteMap>(
  routes: TRoutes,
): LocalReverseFunction<TRoutes> {
  const mount = useMount();
  const currentParams = useParams();

  return useCallback(
    ((
      name: string,
      explicitParams?: Record<string, string | undefined>,
      search?: Record<string, unknown>,
    ): string => {
      if (!name.startsWith(".")) {
        throw new Error(`Local route names must start with ".": "${name}"`);
      }
      const lookupName = name.slice(1);
      const entry = (routes as LocalRouteMap)[lookupName];
      const pattern = getPattern(entry);
      if (pattern === undefined) {
        throw new Error(`Unknown local route: "${name}"`);
      }

      const joined = joinMount(mount, pattern);

      const mergedParams = explicitParams
        ? { ...currentParams, ...explicitParams }
        : currentParams;

      const substituted = substitutePatternParams(joined, mergedParams, name);

      if (search) {
        const qs = serializeSearchParams(search);
        if (qs) return `${substituted}?${qs}`;
      }

      return substituted;
    }) as LocalReverseFunction<TRoutes>,
    [routes, mount, currentParams],
  );
}
