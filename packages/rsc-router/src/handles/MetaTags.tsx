"use client";

/**
 * Component to render collected meta descriptors in the document head.
 *
 * @example
 * ```tsx
 * function RootLayout() {
 *   return (
 *     <html>
 *       <head>
 *         <MetaTags />
 *       </head>
 *       <body>...</body>
 *     </html>
 *   );
 * }
 * ```
 */

import { useHandle } from "../browser/react/use-handle.ts";
import { Meta } from "./meta.ts";
import type { MetaDescriptor } from "../router/types.ts";

// Type guards for MetaDescriptor variants
function hasCharSet(d: MetaDescriptor): d is { charSet: "utf-8" } {
  return "charSet" in d && d.charSet === "utf-8";
}

function hasTitle(d: MetaDescriptor): d is { title: string } {
  return "title" in d && typeof (d as { title?: unknown }).title === "string";
}

function hasNameContent(d: MetaDescriptor): d is { name: string; content: string } {
  return "name" in d && "content" in d &&
    typeof (d as { name?: unknown }).name === "string" &&
    typeof (d as { content?: unknown }).content === "string";
}

function hasPropertyContent(d: MetaDescriptor): d is { property: string; content: string } {
  return "property" in d && "content" in d &&
    typeof (d as { property?: unknown }).property === "string" &&
    typeof (d as { content?: unknown }).content === "string";
}

function hasHttpEquivContent(d: MetaDescriptor): d is { httpEquiv: string; content: string } {
  return "httpEquiv" in d && "content" in d &&
    typeof (d as { httpEquiv?: unknown }).httpEquiv === "string" &&
    typeof (d as { content?: unknown }).content === "string";
}

function hasScriptLdJson(d: MetaDescriptor): d is { "script:ld+json": object } {
  return "script:ld+json" in d;
}

function hasTagName(d: MetaDescriptor): d is { tagName: "meta" | "link"; [name: string]: string } {
  return "tagName" in d && ((d as { tagName?: unknown }).tagName === "meta" || (d as { tagName?: unknown }).tagName === "link");
}

/**
 * Render a single meta descriptor as a React element.
 */
function renderMetaDescriptor(
  descriptor: MetaDescriptor,
  index: number
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
      return <link key={`link-${index}`} {...(rest as React.LinkHTMLAttributes<HTMLLinkElement>)} />;
    }
    if (tagName === "meta") {
      return <meta key={`meta-${index}`} {...(rest as React.MetaHTMLAttributes<HTMLMetaElement>)} />;
    }
  }

  // Fallback: treat as meta attributes
  return <meta key={`meta-fallback-${index}`} {...(descriptor as React.MetaHTMLAttributes<HTMLMetaElement>)} />;
}

/**
 * Renders all collected meta descriptors from route handlers.
 *
 * Place this component inside the `<head>` element of your document.
 * It will automatically update when meta descriptors change during navigation.
 */
export function MetaTags(): React.ReactNode {
  const descriptors = useHandle(Meta);

  return <>{descriptors.map(renderMetaDescriptor)}</>;
}
