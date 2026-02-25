"use client";

/**
 * Component to render collected meta descriptors in the document head.
 *
 * Supports both sync and async meta descriptors. Async descriptors
 * (Promise<MetaDescriptorBase>) are resolved using React's use() hook.
 *
 * When theme is enabled in the router config, MetaTags also renders
 * the theme initialization script to prevent FOUC (flash of unstyled content).
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
import type { MetaDescriptor, MetaDescriptorBase } from "../router/types.js";
import { getSSRThemeConfig } from "../theme/theme-context.js";
import { generateThemeScript } from "../theme/theme-script.js";

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
 * Check if a value is a Promise.
 */
function isPromise(value: unknown): value is Promise<unknown> {
  return value !== null && typeof value === "object" && "then" in value;
}

/**
 * Render a single meta descriptor as a React element.
 */
function renderMetaDescriptor(
  descriptor: MetaDescriptorBase,
  index: number,
): React.ReactNode {
  // charset
  if (hasCharSet(descriptor)) {
    return <meta key="charSet" charSet={descriptor.charSet} />;
  }

  // title
  if (hasTitle(descriptor)) {
    return <title key="title">{descriptor.title}</title>;
  }

  // name + content (description, viewport, etc.)
  if (hasNameContent(descriptor)) {
    return (
      <meta
        key={`name-${descriptor.name}`}
        name={descriptor.name}
        content={descriptor.content}
      />
    );
  }

  // property + content (Open Graph, etc.)
  if (hasPropertyContent(descriptor)) {
    return (
      <meta
        key={`property-${descriptor.property}`}
        property={descriptor.property}
        content={descriptor.content}
      />
    );
  }

  // http-equiv + content
  if (hasHttpEquivContent(descriptor)) {
    return (
      <meta
        key={`httpEquiv-${descriptor.httpEquiv}`}
        httpEquiv={descriptor.httpEquiv}
        content={descriptor.content}
      />
    );
  }

  // JSON-LD structured data
  if (hasScriptLdJson(descriptor)) {
    const json = JSON.stringify(descriptor["script:ld+json"]);
    return (
      <script
        key={`ld-json-${index}`}
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: json }}
      />
    );
  }

  // Custom tagName (meta or link with arbitrary attributes)
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

  // Fallback: treat as meta attributes
  return (
    <meta
      key={`meta-fallback-${index}`}
      {...(descriptor as React.MetaHTMLAttributes<HTMLMetaElement>)}
    />
  );
}

/**
 * Wrapper component to resolve a Promise<MetaDescriptorBase> using use().
 */
function AsyncMetaTag({
  promise,
  index,
}: {
  promise: Promise<MetaDescriptorBase>;
  index: number;
}): React.ReactNode {
  const resolved = use(promise);
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
  const themeConfig = getSSRThemeConfig();

  return (
    <>
      {/* Theme script must be first to prevent FOUC */}
      {themeConfig && (
        <script
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
