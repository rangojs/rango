"use client";

/**
 * Component to render collected meta descriptors in the document head.
 *
 * Supports both sync and async meta descriptors. Async descriptors
 * (Promise<MetaDescriptorBase>) are resolved using React's use() hook.
 *
 * When theme is enabled in the router config, MetaTags also renders
 * the theme initialization script to prevent FOUC (flash of unstyled content).
 * This makes MetaTags the sole FOUC-script injector for apps that render it;
 * the standalone `<ThemeScript />` is only needed when MetaTags is not used.
 * Rendering both is safe (the inline script guards listener registration) but
 * redundant.
 *
 * @example
 * ```tsx
 * function RootLayout() {
 *   return (
 *     <html lang="en" suppressHydrationWarning>
 *       <head>
 *         <MetaTags />
 *       </head>
 *       <body>...</body>
 *     </html>
 *   );
 * }
 * ```
 */

import { use } from "react";
import { useHandle } from "../browser/react/use-handle.js";
import { Meta } from "./meta.js";
import { isThenable } from "./is-thenable.js";
import type { MetaDescriptor, MetaDescriptorBase } from "../router/types.js";
import { useThemeContext } from "../theme/theme-context.js";
import { generateThemeScript } from "../theme/theme-script.js";
import { useNonce } from "../browser/react/nonce-context.js";
import { escapeJsonForScript } from "../escape-script.js";

// Type guards for MetaDescriptorBase variants
function hasCharSet(d: MetaDescriptorBase): d is { charSet: "utf-8" } {
  return "charSet" in d && d.charSet === "utf-8";
}

function hasTitle(d: MetaDescriptorBase): d is { title: string } {
  return "title" in d && typeof (d as { title?: unknown }).title === "string";
}

function hasNameContent(
  d: MetaDescriptorBase,
): d is { name: string; content: string } {
  return (
    "name" in d &&
    "content" in d &&
    typeof (d as { name?: unknown }).name === "string" &&
    typeof (d as { content?: unknown }).content === "string"
  );
}

function hasPropertyContent(
  d: MetaDescriptorBase,
): d is { property: string; content: string } {
  return (
    "property" in d &&
    "content" in d &&
    typeof (d as { property?: unknown }).property === "string" &&
    typeof (d as { content?: unknown }).content === "string"
  );
}

function hasHttpEquivContent(
  d: MetaDescriptorBase,
): d is { httpEquiv: string; content: string } {
  return (
    "httpEquiv" in d &&
    "content" in d &&
    typeof (d as { httpEquiv?: unknown }).httpEquiv === "string" &&
    typeof (d as { content?: unknown }).content === "string"
  );
}

function hasScriptLdJson(
  d: MetaDescriptorBase,
): d is { "script:ld+json": object } {
  return "script:ld+json" in d;
}

function hasTagName(
  d: MetaDescriptorBase,
): d is { tagName: "meta" | "link"; [name: string]: string } {
  return (
    "tagName" in d &&
    ((d as { tagName?: unknown }).tagName === "meta" ||
      (d as { tagName?: unknown }).tagName === "link")
  );
}

/**
 * Check if a value is a Promise. Uses the shared thenable predicate (callable
 * `then`) so collect (meta.ts) and render never disagree: an object carrying a
 * non-callable `then` (e.g. `{ then: 5 }`) is a SYNC descriptor on both sides,
 * not a Promise that would crash React's `use()`.
 */
function isPromise(value: unknown): value is Promise<unknown> {
  return isThenable(value);
}

function renderMetaDescriptor(
  descriptor: MetaDescriptorBase,
  index: number,
): React.ReactNode {
  if (hasCharSet(descriptor)) {
    return <meta key="charSet" charSet={descriptor.charSet} />;
  }

  if (hasTitle(descriptor)) {
    return <title key="title">{descriptor.title}</title>;
  }

  if (hasNameContent(descriptor)) {
    return (
      <meta
        key={`name-${descriptor.name}`}
        name={descriptor.name}
        content={descriptor.content}
      />
    );
  }

  if (hasPropertyContent(descriptor)) {
    return (
      <meta
        key={`property-${descriptor.property}`}
        property={descriptor.property}
        content={descriptor.content}
      />
    );
  }

  if (hasHttpEquivContent(descriptor)) {
    return (
      <meta
        key={`httpEquiv-${descriptor.httpEquiv}`}
        httpEquiv={descriptor.httpEquiv}
        content={descriptor.content}
      />
    );
  }

  if (hasScriptLdJson(descriptor)) {
    const json = escapeJsonForScript(
      JSON.stringify(descriptor["script:ld+json"]),
    );
    return (
      <script
        key={`ld-json-${index}`}
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: json }}
      />
    );
  }

  if (hasTagName(descriptor)) {
    const { tagName, ...rest } = descriptor;
    if (tagName === "link") {
      return (
        <link
          key={`link-${index}`}
          {...(rest as React.LinkHTMLAttributes<HTMLLinkElement>)}
        />
      );
    }
    if (tagName === "meta") {
      return (
        <meta
          key={`meta-${index}`}
          {...(rest as React.MetaHTMLAttributes<HTMLMetaElement>)}
        />
      );
    }
  }

  return (
    <meta
      key={`meta-fallback-${index}`}
      {...(descriptor as React.MetaHTMLAttributes<HTMLMetaElement>)}
    />
  );
}

// Sentinel a rejected async descriptor resolves to: renderMetaDescriptor sees
// no recognized fields and returns nothing renderable (see renderRejected).
const REJECTED_META: unique symbol = Symbol("rango.rejectedMeta");

// Cache the rejection-swallowing wrapper per source promise so use() gets a
// stable reference across re-renders (a fresh .then() each render would make
// React treat it as a new pending promise and never settle). WeakMap keys on
// the original promise so entries are collected with it.
const safeMetaPromises = new WeakMap<
  Promise<MetaDescriptorBase>,
  Promise<MetaDescriptorBase | typeof REJECTED_META>
>();

function toSafeMetaPromise(
  promise: Promise<MetaDescriptorBase>,
): Promise<MetaDescriptorBase | typeof REJECTED_META> {
  let safe = safeMetaPromises.get(promise);
  if (!safe) {
    // Swallow the rejection at the promise boundary, not via an error boundary:
    // an error boundary above a suspended use() makes React abandon the whole
    // Suspense subtree (and on the server switch it to client rendering). A
    // settled-to-sentinel promise degrades the single bad descriptor to nothing
    // while every sibling descriptor still renders.
    safe = promise.then(
      (value) => value,
      () => REJECTED_META,
    );
    safeMetaPromises.set(promise, safe);
  }
  return safe;
}

export function AsyncMetaTag({
  promise,
  index,
}: {
  promise: Promise<MetaDescriptorBase>;
  index: number;
}): React.ReactNode {
  const resolved = use(toSafeMetaPromise(promise));
  if (resolved === REJECTED_META) return null;
  return renderMetaDescriptor(resolved, index);
}

/**
 * Renders all collected meta descriptors from route handlers.
 *
 * Place this component inside the `<head>` element of your document.
 * It will automatically update when meta descriptors change during navigation.
 *
 * When theme is enabled in router config, also renders the theme initialization
 * script to prevent FOUC (flash of unstyled content).
 *
 * Async meta descriptors (Promise<MetaDescriptorBase>) are resolved using
 * React's use() hook. RSC streaming handles the Promise resolution.
 */
export function MetaTags(): React.ReactNode {
  const descriptors = useHandle(Meta) as MetaDescriptor[];
  const themeConfig = useThemeContext()?.config ?? null;
  const nonce = useNonce();

  return (
    <>
      {/* Theme script must be first to prevent FOUC */}
      {themeConfig && (
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{ __html: generateThemeScript(themeConfig) }}
        />
      )}
      {descriptors.map((descriptor, index) => {
        if (isPromise(descriptor)) {
          return (
            <AsyncMetaTag
              key={`async-${index}`}
              promise={descriptor}
              index={index}
            />
          );
        }
        return renderMetaDescriptor(descriptor, index);
      })}
    </>
  );
}
