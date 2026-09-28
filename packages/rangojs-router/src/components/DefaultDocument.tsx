"use client";

import type { ReactNode, ReactElement } from "react";
import { MetaTags } from "../handles/MetaTags.js";
import { Scripts } from "../handles/Scripts.js";
import { ScrollRestoration } from "../browser/react/ScrollRestoration.js";

/**
 * Default document component that provides a basic HTML structure.
 * Used when no custom document is provided to createRouter.
 * Renders every Html member: Html.Meta (charset, viewport, route meta), head +
 * body Html.Scripts sites for the Script handle, and Html.ScrollRestoration.
 * An app that wants a custom getKey or no scroll restoration passes its own
 * document; rendering a second Html.ScrollRestoration under this one only
 * warns ("[Scroll] Already initialized").
 *
 * Uses suppressHydrationWarning on <html> because the theme script
 * may modify class/style attributes before React hydrates.
 */
export function DefaultDocument({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <MetaTags />
        <Scripts />
      </head>
      <body>
        <Scripts position="body" />
        {children}
        <ScrollRestoration />
      </body>
    </html>
  );
}
