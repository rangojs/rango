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
import { isThenable } from "./is-thenable.js";
import type {
  MetaDescriptor,
  MetaDescriptorBase,
  TitleDescriptor,
  UnsetDescriptor,
} from "../router/types.js";

function isPromiseDescriptor(
  descriptor: MetaDescriptor,
): descriptor is Promise<MetaDescriptorBase> {
  return isThenable(descriptor);
}

function isUnsetDescriptor(
  descriptor: MetaDescriptor,
): descriptor is UnsetDescriptor {
  return (
    typeof descriptor === "object" &&
    descriptor !== null &&
    "unset" in descriptor &&
    typeof (descriptor as UnsetDescriptor).unset === "string"
  );
}

function isTitleDescriptor(
  descriptor: MetaDescriptor,
): descriptor is { title: TitleDescriptor } {
  return (
    typeof descriptor === "object" &&
    descriptor !== null &&
    "title" in descriptor
  );
}

function isTitleTemplate(
  title: TitleDescriptor,
): title is { template: string; default: string } {
  return (
    typeof title === "object" &&
    title !== null &&
    "template" in title &&
    "default" in title
  );
}

function isAbsoluteTitle(
  title: TitleDescriptor,
): title is { absolute: string } {
  return typeof title === "object" && title !== null && "absolute" in title;
}

function getMetaKey(descriptor: MetaDescriptor): string | undefined {
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
    return undefined;
  }
  if ("tagName" in descriptor) {
    if (descriptor.tagName === "link" && "rel" in descriptor) {
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

function addOrReplace(
  result: MetaDescriptor[],
  keyToIndex: Map<string, number>,
  descriptor: MetaDescriptor,
  key: string | undefined,
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

function updateIndicesAfterRemoval(
  keyToIndex: Map<string, number>,
  removedIndex: number,
): void {
  for (const [key, index] of keyToIndex) {
    if (index > removedIndex) {
      keyToIndex.set(key, index - 1);
    }
  }
}

function collectMeta(segments: MetaDescriptor[][]): MetaDescriptor[] {
  const result: MetaDescriptor[] = [];
  const keyToIndex = new Map<string, number>();
  let titleTemplate: string | undefined;

  for (const descriptor of defaultMetaDescriptors) {
    const key = getMetaKey(descriptor);
    if (key !== undefined) {
      keyToIndex.set(key, result.length);
    }
    result.push(descriptor);
  }

  for (const descriptors of segments) {
    for (const descriptor of descriptors) {
      // Promise descriptors cannot be inspected synchronously (their content is
      // unknown until resolved in <MetaTags> via React's use()), so they bypass
      // key-based dedup and title-templating: they are appended verbatim. Warn in
      // dev when a title template is active so the author knows an async
      // descriptor will NOT participate in the template/dedup.
      //
      // The warning is deliberately a GENERAL note, not a duplicate-<title>
      // prediction: collectMeta cannot tell whether this Promise resolves to a
      // title (which would indeed yield a 2nd <title>) or to an ordinary
      // descriptor like an async og:image (which would not). Asserting a
      // duplicate <title> here is a false positive for the common og:image case,
      // so the message states only that async descriptors bypass templating —
      // not that a duplicate <title> WILL occur.
      if (isPromiseDescriptor(descriptor)) {
        if (
          titleTemplate !== undefined &&
          process.env.NODE_ENV !== "production"
        ) {
          console.warn(
            `[Meta] A Promise meta descriptor was pushed while a title template is active. ` +
              `Async descriptors bypass deduplication and title-templating: the template is ` +
              `not applied to them. If this Promise resolves to a title, resolve the value ` +
              `before pushing (or push a synchronous descriptor) so it participates in the ` +
              `template; if it resolves to a non-title descriptor (e.g. og:image), this ` +
              `note does not apply.`,
          );
        }
        result.push(descriptor);
        continue;
      }

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

      if (isTitleDescriptor(descriptor)) {
        const titleValue = descriptor.title;

        if (isTitleTemplate(titleValue)) {
          titleTemplate = titleValue.template;
          addOrReplace(
            result,
            keyToIndex,
            { title: titleValue.default },
            "title",
          );
          continue;
        }

        if (isAbsoluteTitle(titleValue)) {
          addOrReplace(
            result,
            keyToIndex,
            { title: titleValue.absolute },
            "title",
          );
          continue;
        }

        // Insert the title literally. String.prototype.replace treats the
        // replacement string specially ($&, $`, $', $$, $n), so a title like
        // "Save $5" or one containing "$&" would be mangled. split/join inserts
        // the raw value with no special-character interpretation.
        const finalTitle = titleTemplate
          ? titleTemplate.split("%s").join(titleValue as string)
          : titleValue;
        addOrReplace(
          result,
          keyToIndex,
          { title: finalTitle as string },
          "title",
        );
        continue;
      }

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
 *
 * Deduplication and title-templating apply only to SYNCHRONOUS descriptors.
 * A Promise descriptor (`Promise<MetaDescriptorBase>`) is appended verbatim —
 * its content is not known until it resolves in `<MetaTags>`, so it cannot be
 * keyed for dedup nor receive a parent title template. If you need a child title
 * to participate in a layout's `%s` template, push the resolved string title
 * synchronously rather than a `Promise<{ title }>`.
 */
export const Meta: Handle<MetaDescriptor, MetaDescriptor[]> = createHandle<
  MetaDescriptor,
  MetaDescriptor[]
>(collectMeta, "__rsc_router_meta__");
