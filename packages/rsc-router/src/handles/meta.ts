/**
 * Built-in Meta handle for managing document metadata across route segments.
 *
 * Provides automatic deduplication: later routes override earlier ones
 * for the same meta key (title, name, property, etc.)
 *
 * @example
 * ```tsx
 * // In route handler
 * route("product/:id", (ctx) => {
 *   const meta = ctx.use(Meta);
 *   meta({ title: "Product Details" });
 *   meta({ name: "description", content: "..." });
 *   meta({ property: "og:title", content: "..." });
 * });
 *
 * // In layout (renders the collected meta tags)
 * function RootLayout() {
 *   return (
 *     <html>
 *       <head>
 *         <MetaTags />
 *       </head>
 *       ...
 *     </html>
 *   );
 * }
 * ```
 */

import { createHandle, type Handle } from "../handle.ts";
import type { MetaDescriptor } from "../router/types.ts";

/**
 * Get a unique key for a meta descriptor for deduplication.
 * Returns undefined for descriptors that shouldn't be deduplicated.
 */
function getMetaKey(descriptor: MetaDescriptor): string | undefined {
  if ("charSet" in descriptor) {
    return "charSet";
  }
  if ("title" in descriptor) {
    return "title";
  }
  if ("name" in descriptor && "content" in descriptor) {
    return `name:${descriptor.name}`;
  }
  if ("property" in descriptor && "content" in descriptor) {
    return `property:${descriptor.property}`;
  }
  if ("httpEquiv" in descriptor && "content" in descriptor) {
    return `httpEquiv:${descriptor.httpEquiv}`;
  }
  if ("script:ld+json" in descriptor) {
    // JSON-LD scripts can have multiple, don't dedupe by default
    return undefined;
  }
  if ("tagName" in descriptor) {
    // For link tags, dedupe by rel if present
    if (descriptor.tagName === "link" && "rel" in descriptor) {
      // Some link rels should be unique (canonical), others not (stylesheet)
      const uniqueRels = ["canonical", "icon", "apple-touch-icon"];
      if (uniqueRels.includes(descriptor.rel as string)) {
        return `link:${descriptor.rel}`;
      }
    }
    return undefined;
  }
  return undefined;
}

/**
 * Collect function for Meta handle.
 * Deduplicates meta descriptors by key, with later routes overriding earlier ones.
 */
function collectMeta(segments: MetaDescriptor[][]): MetaDescriptor[] {
  const result: MetaDescriptor[] = [];
  const keyToIndex = new Map<string, number>();

  for (const descriptors of segments) {
    for (const descriptor of descriptors) {
      const key = getMetaKey(descriptor);

      if (key !== undefined && keyToIndex.has(key)) {
        // Override existing descriptor with same key
        result[keyToIndex.get(key)!] = descriptor;
      } else {
        // Add new descriptor
        if (key !== undefined) {
          keyToIndex.set(key, result.length);
        }
        result.push(descriptor);
      }
    }
  }

  return result;
}

/**
 * Built-in handle for managing document metadata.
 *
 * Use `ctx.use(Meta)` in route handlers to push meta descriptors.
 * Use `<MetaTags />` component to render them in the document head.
 */
export const Meta: Handle<MetaDescriptor, MetaDescriptor[]> = createHandle<MetaDescriptor, MetaDescriptor[]>(
  "__rsc_router_meta__",
  collectMeta
);
