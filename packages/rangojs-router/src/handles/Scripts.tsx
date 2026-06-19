"use client";

/**
 * Renders the scripts collected by the Script handle into the document.
 *
 * Place `<Scripts />` inside `<head>` (default) and, if you push body scripts,
 * `<Scripts position="body" />` at the top of `<body>`. Each site renders the
 * configs whose `position` matches; the request CSP nonce is applied
 * automatically to every DOCUMENT-RENDERED <script> (consumers never pass it). An
 * async script first encountered on a soft navigation is injected client-side
 * where the nonce is unavailable, so it carries no nonce and relies on
 * 'strict-dynamic' (or a host allowance) — see the nonce caveat in the /scripts
 * skill.
 *
 * EXECUTION CONTRACT — see the Script handle's docs. Inline + ordered (defer)
 * scripts are document-load: they execute only when present in the initial HTML,
 * so this component FREEZES that set after hydration (the initializer below runs
 * once) — a later soft navigation never inserts an inert <script> (React creates
 * client-mounted scripts via innerHTML, which the HTML spec makes non-executing).
 * Async external scripts are React resources and stay reactive: React loads them
 * on first encounter, including after navigation, deduped by src.
 *
 * @example
 * ```tsx
 * <html>
 *   <head>
 *     <MetaTags />
 *     <Scripts />
 *   </head>
 *   <body>
 *     <Scripts position="body" />
 *     {children}
 *   </body>
 * </html>
 * ```
 */

import { useState, type ReactNode } from "react";
import { useHandle } from "../browser/react/use-handle.js";
import { useNonce } from "../browser/react/nonce-context.js";
import { escapeScriptBody } from "../escape-script.js";
import { Script, type ScriptAttributes, type ScriptConfig } from "./script.js";

/** An external async script is a React-managed resource (reactive on nav). */
function isAsyncResource(config: ScriptConfig): boolean {
  return config.src != null && config.async === true;
}

// Fields the Script handle owns (set via the ScriptConfig fields, applied as
// explicit props by renderScript) plus the inline-content props. Dropped from the
// attributes bag so untyped/serialized input cannot smuggle them in — e.g.
// `children`/`dangerouslySetInnerHTML` alongside an inline body makes React throw,
// or `src` on an inline script. The discriminated type already excludes these;
// this is the runtime guard.
const MANAGED_ATTRS = new Set([
  "id",
  "src",
  "async",
  "defer",
  "type",
  "children",
  "nonce",
  "dangerouslySetInnerHTML",
]);

// Drop managed fields + any `on*` event handlers (a config serializes across the
// server -> client boundary, so a function cannot survive it) from the passthrough
// attributes, warning in dev.
function passthroughAttributes(
  attributes: ScriptAttributes | undefined,
): Record<string, unknown> {
  if (!attributes) return {};
  const out: Record<string, unknown> = {};
  const dev = process.env.NODE_ENV !== "production";
  for (const [key, value] of Object.entries(
    attributes as Record<string, unknown>,
  )) {
    const isHandler = key.startsWith("on");
    if (isHandler || MANAGED_ATTRS.has(key)) {
      if (dev) {
        console.warn(
          isHandler
            ? `[Scripts] event handler "${key}" in a script's attributes is ` +
                `dropped; callbacks cannot cross the server -> client handle ` +
                `boundary. Use a "use client" component for load/error handling.`
            : `[Scripts] managed field "${key}" in a script's attributes is ` +
                `dropped; set it via the ScriptConfig fields (the request nonce ` +
                `is applied automatically).`,
        );
      }
      continue;
    }
    out[key] = value;
  }
  return out;
}

function renderScript(
  config: ScriptConfig,
  nonce: string | undefined,
  index: number,
): ReactNode {
  const { id, src, children, async, defer, type, attributes } = config;
  const key = id ?? src ?? `rango-script-${index}`;
  const attrs = passthroughAttributes(attributes);

  // Inline: rendered in place (never hoisted), escaped against </script> breakout.
  // The server-only nonce makes the attribute differ from the (undefined) client
  // value, so suppressHydrationWarning is required — the same sanctioned pattern
  // as the theme/Meta inline scripts.
  if (src == null) {
    if (children == null) return null;
    return (
      <script
        key={key}
        {...attrs}
        id={id}
        type={type}
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: escapeScriptBody(children) }}
      />
    );
  }

  if (
    process.env.NODE_ENV !== "production" &&
    config.position === "body" &&
    async
  ) {
    console.warn(
      `[Scripts] An async external script (src="${src}") is hoisted into ` +
        `<head> by React; position: "body" is ignored for it.`,
    );
  }

  // External: async => React-hoisted, src-deduped resource; otherwise in place
  // (defer or plain), preserving authoring order.
  return (
    <script
      key={key}
      {...attrs}
      id={id}
      type={type}
      src={src}
      async={async}
      defer={defer}
      nonce={nonce}
      suppressHydrationWarning
    />
  );
}

export function Scripts({
  position = "head",
}: { position?: "head" | "body" } = {}): ReactNode {
  const all = useHandle(Script) as ScriptConfig[];
  const nonce = useNonce();

  const forPosition = all.filter(
    (config) => (config.position ?? "head") === position,
  );

  // Document-load scripts (inline + ordered external) execute only from the
  // initial HTML, so freeze them to the first-render set. The initializer runs
  // during SSR and again at hydration with the same handle data, so the output
  // matches; afterwards a navigation cannot add an inert <script>.
  const [documentLoad] = useState(() =>
    forPosition.filter((config) => !isAsyncResource(config)),
  );
  // Async external scripts are resources React loads on first encounter; keep
  // them reactive so a script first reached via navigation still loads.
  const asyncResources = forPosition.filter(isAsyncResource);

  return (
    <>
      {documentLoad.map((config, index) => renderScript(config, nonce, index))}
      {asyncResources.map((config, index) =>
        renderScript(config, nonce, index),
      )}
    </>
  );
}
