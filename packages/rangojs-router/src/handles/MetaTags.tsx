"use client";

/**
 * Component to render collected meta descriptors in the document head.
 *
 * Deferred (Promise) meta descriptors are resolved before MetaTags renders
 * (server-side on the full render, client-side before apply on navigation), so
 * it only ever receives resolved descriptors and never suspends.
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

import { useHandle } from "../browser/react/use-handle.js";
import { Meta } from "./meta.js";
import type { MetaDescriptorBase } from "../router/types.js";
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

export function renderMetaDescriptor(
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

/**
 * Renders all collected meta descriptors from route handlers.
 *
 * Place this component inside the `<head>` element of your document.
 * It will automatically update when meta descriptors change during navigation.
 *
 * When theme is enabled in router config, also renders the theme initialization
 * script to prevent FOUC (flash of unstyled content).
 *
 * Deferred (Promise) meta descriptors are resolved BEFORE MetaTags renders —
 * server-side on the full/SSR render, client-side before apply on navigation
 * (resolve-by-default) — so MetaTags only ever receives resolved descriptors and
 * never suspends.
 */
export function MetaTags(): React.ReactNode {
  // collectMeta resolves deferred descriptors and strips unset markers, so the
  // collected output is always resolved base descriptors (never a Promise).
  const descriptors = useHandle(Meta) as MetaDescriptorBase[];
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
      {descriptors.map((descriptor, index) =>
        renderMetaDescriptor(descriptor, index),
      )}
    </>
  );
}
