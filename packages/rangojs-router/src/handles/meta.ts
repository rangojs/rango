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

import { createHandle, type Handle } from "../handle.js";
import type {
  MetaDescriptor,
  TitleDescriptor,
  UnsetDescriptor,
} from "../router/types.js";

/**
 * Type guard for unset descriptor
 */
function isUnsetDescriptor(
  descriptor: MetaDescriptor
): descriptor is UnsetDescriptor {
  return (
    typeof descriptor === "object" &&
    descriptor !== null &&
    "unset" in descriptor &&
    typeof (descriptor as UnsetDescriptor).unset === "string"
  );
}

/**
 * Type guard for title descriptor (any form)
 */
function isTitleDescriptor(
  descriptor: MetaDescriptor
): descriptor is { title: TitleDescriptor } {
  return (
    typeof descriptor === "object" &&
    descriptor !== null &&
    "title" in descriptor
  );
}

/**
 * Type guard for title template descriptor
 */
function isTitleTemplate(
  title: TitleDescriptor
): title is { template: string; default: string } {
  return (
    typeof title === "object" &&
    title !== null &&
    "template" in title &&
    "default" in title
  );
}

/**
 * Type guard for absolute title descriptor
 */
function isAbsoluteTitle(title: TitleDescriptor): title is { absolute: string } {
  return typeof title === "object" && title !== null && "absolute" in title;
}

/**
 * Get a unique key for a meta descriptor for deduplication.
 * Returns undefined for descriptors that shouldn't be deduplicated.
 */
function getMetaKey(descriptor: MetaDescriptor): string | undefined {
  // Skip unset descriptors - they are processed separately
  if (isUnsetDescriptor(descriptor)) {
    return undefined;
  }
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
 * Default meta descriptors included automatically.
 * These can be overridden by route handlers.
 */
const defaultMetaDescriptors: MetaDescriptor[] = [
  { charSet: "utf-8" },
  { name: "viewport", content: "width=device-width, initial-scale=1" },
];

/**
 * Helper to add or replace a descriptor in the result array
 */
function addOrReplace(
  result: MetaDescriptor[],
  keyToIndex: Map<string, number>,
  descriptor: MetaDescriptor,
  key: string | undefined
): void {
  if (key !== undefined && keyToIndex.has(key)) {
    result[keyToIndex.get(key)!] = descriptor;
  } else {
    if (key !== undefined) {
      keyToIndex.set(key, result.length);
    }
    result.push(descriptor);
  }
}

/**
 * Helper to update indices after removing an element
 */
function updateIndicesAfterRemoval(
  keyToIndex: Map<string, number>,
  removedIndex: number
): void {
  for (const [key, index] of keyToIndex) {
    if (index > removedIndex) {
      keyToIndex.set(key, index - 1);
    }
  }
}

/**
 * Collect function for Meta handle.
 * Includes default meta descriptors, then deduplicates by key with later routes overriding earlier ones.
 * Supports title templates, absolute titles, and unset descriptors.
 */
function collectMeta(segments: MetaDescriptor[][]): MetaDescriptor[] {
  const result: MetaDescriptor[] = [];
  const keyToIndex = new Map<string, number>();
  let titleTemplate: string | undefined;

  // Add defaults first so they can be overridden
  for (const descriptor of defaultMetaDescriptors) {
    const key = getMetaKey(descriptor);
    if (key !== undefined) {
      keyToIndex.set(key, result.length);
    }
    result.push(descriptor);
  }

  for (const descriptors of segments) {
    for (const descriptor of descriptors) {
      // Handle unset descriptors
      if (isUnsetDescriptor(descriptor)) {
        const keyToRemove = descriptor.unset;
        if (keyToIndex.has(keyToRemove)) {
          const idx = keyToIndex.get(keyToRemove)!;
          result.splice(idx, 1);
          keyToIndex.delete(keyToRemove);
          updateIndicesAfterRemoval(keyToIndex, idx);
        }
        continue;
      }

      // Handle title descriptors with template/absolute support
      if (isTitleDescriptor(descriptor)) {
        const titleValue = descriptor.title;

        if (isTitleTemplate(titleValue)) {
          // Store template for subsequent title descriptors in child segments
          titleTemplate = titleValue.template;
          // Set the default title
          addOrReplace(result, keyToIndex, { title: titleValue.default }, "title");
          continue;
        }

        if (isAbsoluteTitle(titleValue)) {
          // Absolute title bypasses any template
          addOrReplace(result, keyToIndex, { title: titleValue.absolute }, "title");
          continue;
        }

        // String title - apply template if one exists
        const finalTitle = titleTemplate
          ? titleTemplate.replace("%s", titleValue as string)
          : titleValue;
        addOrReplace(result, keyToIndex, { title: finalTitle as string }, "title");
        continue;
      }

      // Handle all other descriptors
      const key = getMetaKey(descriptor);
      addOrReplace(result, keyToIndex, descriptor, key);
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
  collectMeta,
  "__rsc_router_meta__"
);
