"use client";

import { useContext } from "react";
import { MountContext } from "./mount-context.js";

/**
 * Returns the current include() mount path.
 *
 * Inside `include("/articles", blogPatterns)`, returns "/articles".
 * For nested includes, returns the nearest mount path.
 * At root level (no include), returns "/".
 *
 * @example
 * ```tsx
 * "use client";
 * import { useMount, href } from "@rangojs/router/client";
 *
 * function BlogNav({ slug }: { slug: string }) {
 *   const mount = useMount(); // "/articles"
 *   return (
 *     <>
 *       <Link to={href("/", mount)}>Blog Home</Link>
 *       <Link to={href(`/${slug}`, mount)}>Post</Link>
 *     </>
 *   );
 * }
 * ```
 */
export function useMount(): string {
  return useContext(MountContext);
}
