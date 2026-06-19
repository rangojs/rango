/**
 * Built-in Script handle for injecting <script> tags into the document from
 * route/layout handlers.
 *
 * Push from a SERVER handler with `ctx.use(Script)(config)`; render with the
 * `<Scripts />` component (from `@rangojs/router/client`) placed in the Document
 * `<head>` (and optionally a second `<Scripts position="body" />` at the top of
 * `<body>`). This mirrors the Meta / <MetaTags> pair.
 *
 * The request CSP nonce is applied AUTOMATICALLY by <Scripts> to document-rendered
 * scripts; consumers never pass a nonce. (An async script first loaded on a soft
 * navigation is injected client-side without a nonce — it relies on
 * 'strict-dynamic' or a host allowance; see the EXECUTION CONTRACT below and the
 * /scripts skill.) A ScriptConfig is fully serializable (it crosses the
 * server -> client handle-collection boundary), so callbacks like onLoad are NOT
 * supported — a consumer needing them renders their own "use client" script.
 *
 * EXECUTION CONTRACT (see the /scripts skill for the full story):
 * - Inline (`children`) and ordered external (`src`, optional `defer`) scripts
 *   are DOCUMENT-LOAD scripts: they execute only when present in the initial HTML
 *   response. <Scripts> freezes them after hydration, so a later client (soft)
 *   navigation never inserts an inert copy — React creates client-mounted
 *   <script> elements via innerHTML, which the HTML spec makes non-executing.
 * - Async external scripts (`src` + `async: true`) are React RESOURCES: they load
 *   once when first encountered, including after a soft navigation, deduped by
 *   `src`. Use this for a vendor that should load on first visit to a route.
 * - Reusing an `id` shapes the INITIAL document output (last-push-wins); it does
 *   not re-run a script during navigation. Per-navigation behavior belongs in a
 *   "use client" component or hook (see the GtmPageViews pattern in the demo).
 *
 * @example
 * ```ts
 * // External async loader (React resource — loads on first visit, even soft nav):
 * ctx.use(Script)({ id: "stripe", src: "https://js.stripe.com/v3", async: true });
 *
 * // Inline bootstrap that self-injects its loader (GTM/GA4) — keep it inline so
 * // React cannot hoist a declarative loader above the bootstrap:
 * ctx.use(Script)({ id: "gtm", children: gtmBootstrap(containerId) });
 *
 * // External ordered (defer) with vendor attributes (document-load):
 * ctx.use(Script)({
 *   id: "plausible",
 *   src: "https://plausible.io/js/script.js",
 *   defer: true,
 *   attributes: { "data-domain": "example.com" },
 * });
 * ```
 */

import type { ScriptHTMLAttributes } from "react";
import { createHandle, type Handle } from "../handle.js";

/**
 * Extra attributes forwarded onto the emitted <script>. Typed by React, so the
 * casing is React's (`crossOrigin`, not `crossorigin`) and value shapes are
 * checked at compile time. `data-*` attributes are allowed. Two groups are
 * excluded: the fields the Script handle manages itself (`id`, `src`, `async`,
 * `defer`, `type`, `children`, `nonce`, `dangerouslySetInnerHTML` — set those via
 * the ScriptConfig fields), and ALL `on*` event handlers (`onLoad`, `onError`,
 * …): a ScriptConfig is serialized across the server -> client handle boundary, so
 * a function cannot survive it — render your own "use client" script for callbacks.
 */
export type ScriptAttributes = Omit<
  ScriptHTMLAttributes<HTMLScriptElement>,
  | "id"
  | "src"
  | "async"
  | "defer"
  | "type"
  | "children"
  | "nonce"
  | "dangerouslySetInnerHTML"
  | `on${string}`
> & {
  [dataAttr: `data-${string}`]: string | number | boolean | undefined;
};

/** Fields shared by every script shape. */
interface ScriptConfigBase {
  /**
   * Where <Scripts> renders this script.
   * - "head" (default): the `<head>` <Scripts> site.
   * - "body": the `<Scripts position="body" />` site at the top of <body>.
   * Note: an external `async` script is hoisted into <head> by React regardless.
   */
  position?: "head" | "body";
  /**
   * The `type` attribute, as a free string: "module", "application/ld+json",
   * "text/partytown", etc. Omitted means a classic script.
   */
  type?: string;
  /** Extra React-cased attributes (`data-*`, `crossOrigin`, `integrity`, ...). */
  attributes?: ScriptAttributes;
}

/**
 * Inline script: a raw JS body rendered in place, escaped against `</script>`
 * breakout. DOCUMENT-LOAD only (executes when present in the initial HTML;
 * <Scripts> freezes it after hydration so navigation never inserts an inert
 * copy). `id` is REQUIRED — inline scripts are never deduped by React, so a
 * layout and a child pushing the same bootstrap would inject it twice. It is also
 * rendered as the script's DOM `id`. Forbids `src`/`async`/`defer`. For analytics
 * vendors (GTM/GA4/Segment) the body should
 * create+append its own loader, so the loader is never a separate declarative tag
 * React could hoist out of order.
 */
export interface InlineScriptConfig extends ScriptConfigBase {
  id: string;
  children: string;
  src?: never;
  async?: never;
  defer?: never;
}

/**
 * External async script: a React-hoisted, `src`-deduped RESOURCE (the
 * fire-and-forget loader case). Loads once when first encountered, including
 * after a soft navigation. Deduped by `src` (matching React); `id` is optional
 * and, when set, is rendered as the DOM `id` (not used as the dedup key here).
 * Forbids `children`/`defer`.
 */
export interface AsyncScriptConfig extends ScriptConfigBase {
  src: string;
  async: true;
  id?: string;
  children?: never;
  defer?: never;
}

/**
 * External ordered script: in-place, optionally `defer`. DOCUMENT-LOAD only
 * (executes when present in the initial HTML; not re-run on navigation). `id` is
 * optional (the dedup key falls back to `src`) and, when set, is rendered as the
 * DOM `id`. Forbids `children`/`async`.
 */
export interface OrderedScriptConfig extends ScriptConfigBase {
  src: string;
  defer?: boolean;
  id?: string;
  children?: never;
  async?: never;
}

/**
 * A single script to inject, as a discriminated union — exactly one of:
 * inline (`id` + `children`), external async (`src` + `async: true`), or external
 * ordered (`src`, optional `defer`). Invalid combinations (both `src`+`children`,
 * `async`+`defer`, inline without `id`) are compile errors. The CSP nonce is
 * applied by <Scripts>, never here.
 */
export type ScriptConfig =
  | InlineScriptConfig
  | AsyncScriptConfig
  | OrderedScriptConfig;

/** A config's runtime view, for validating untyped/serialized input. */
type LooseScriptConfig = {
  id?: string;
  src?: string;
  children?: string;
  async?: boolean;
  defer?: boolean;
};

/**
 * Dev-only validation. The discriminated union makes these states unrepresentable
 * in TypeScript; the runtime checks exist only for untyped JavaScript callers and
 * malformed serialized input, not as the primary contract.
 */
function validateConfigDev(config: ScriptConfig): void {
  if (process.env.NODE_ENV === "production") return;
  const c = config as LooseScriptConfig;
  if (c.src != null && c.children != null) {
    console.warn(
      `[Script] A config has both "src" and "children"; they are mutually ` +
        `exclusive — "src" wins and the inline body is ignored.`,
    );
  } else if (c.src == null && c.children == null) {
    console.warn(
      `[Script] A config has neither "src" nor "children"; it injects nothing.`,
    );
  } else if (c.src == null && c.id == null) {
    console.warn(
      `[Script] An inline script was pushed without an "id" and cannot be ` +
        `deduplicated. Pass an "id" so a layout + child pushing the same script ` +
        `inject it only once.`,
    );
  }
  if (c.async && c.defer) {
    console.warn(
      `[Script] A config has both "async" and "defer"; they are mutually ` +
        `exclusive.`,
    );
  }
}

/**
 * Accumulate scripts across matched segments, parent -> child, preserving push
 * order, last-push-wins per dedup key (mirroring the Meta handle).
 *
 * Dedup key:
 * - async resources key by `src` ONLY — React itself dedups async scripts by src,
 *   so two async configs with different ids but the same src must collapse to one
 *   here (last wins) for a single, deterministic winner; otherwise React would
 *   silently pick one with undefined attribute precedence.
 * - everything else keys by `id ?? src`.
 *
 * An (untyped) inline script with neither `id` nor `src` cannot be deduplicated;
 * it is kept and validateConfigDev warns.
 */
function collectScripts(segments: ScriptConfig[][]): ScriptConfig[] {
  const result: ScriptConfig[] = [];
  const keyToIndex = new Map<string, number>();

  for (const configs of segments) {
    for (const config of configs) {
      validateConfigDev(config);
      const isAsyncResource = config.src != null && config.async === true;
      const key = isAsyncResource ? config.src : (config.id ?? config.src);
      if (key === undefined) {
        result.push(config);
        continue;
      }
      const existing = keyToIndex.get(key);
      if (existing !== undefined) {
        result[existing] = config;
      } else {
        keyToIndex.set(key, result.length);
        result.push(config);
      }
    }
  }

  return result;
}

/**
 * Built-in handle for injecting scripts. Uses an explicit stable id (built-ins
 * do not rely on the Vite id-injection plugin, which only covers consumer code).
 */
export const Script: Handle<ScriptConfig, ScriptConfig[]> = createHandle<
  ScriptConfig,
  ScriptConfig[]
>(collectScripts, "__rsc_router_script__");
