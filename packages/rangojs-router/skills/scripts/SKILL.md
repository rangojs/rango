---
name: scripts
description: Inject third-party scripts (GTM, analytics, widgets) into the document head/body via the Script handle. Use when adding Google Tag Manager, an analytics snippet, or a third-party widget script to the page.
argument-hint: "[vendor]"
---

# Scripts

Inject `<script>` tags into the document the idiomatic Rango way: push a config
from a **server** route/layout handler — or a loader body — with
`ctx.use(Script)(config)`, and render them with the built-in **`<Scripts />`**
component (the `Meta` / `<MetaTags>` pair, but for scripts). The request CSP **nonce is applied automatically to
document-rendered scripts** — you never read or pass it. (The one exception is an
async script first encountered on a soft navigation; see the nonce caveat under
"Execution contract".)

## Setup

`<Scripts />` is a client component; place it in your Document (which is
`"use client"`). The default Document already includes both sites; a custom one
adds them next to `<MetaTags />`:

```tsx
// document.tsx ("use client")
import { MetaTags, Scripts } from "@rangojs/router/client";

export function Document({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <MetaTags />
        <Scripts /> {/* renders position: "head" scripts (the default) */}
      </head>
      <body>
        <Scripts position="body" /> {/* renders position: "body" scripts */}
        {children}
      </body>
    </html>
  );
}
```

## Push from a handler (or loader)

`ScriptConfig` is a discriminated union — exactly one of three shapes, so invalid
combinations are compile errors:

```ts
import { Script } from "@rangojs/router";

// 1. External ASYNC — a React resource. Loads once when first encountered,
//    including after a soft navigation, deduped by src. The fire-and-forget case.
ctx.use(Script)({ id: "stripe", src: "https://js.stripe.com/v3", async: true });

// 2. External ORDERED — in-place, optional `defer`. Document-load (see below).
ctx.use(Script)({
  id: "plausible",
  src: "https://plausible.io/js/script.js",
  defer: true,
  attributes: { "data-domain": "example.com" },
});

// 3. INLINE — `id` REQUIRED, raw JS body (escaped against </script> by <Scripts>).
//    For GTM/GA4/Segment let the body self-inject its loader (see below).
ctx.use(Script)({ id: "gtm", children: gtmBootstrap("GTM-XXXX") });
```

| Shape            | Required             | Optional                                        | Forbidden               |
| ---------------- | -------------------- | ----------------------------------------------- | ----------------------- |
| Inline           | `id`, `children`     | `position`, `type`, `attributes`                | `src`, `async`, `defer` |
| External async   | `src`, `async: true` | `id`, `position`, `type`, `attributes`          | `children`, `defer`     |
| External ordered | `src`                | `defer`, `id`, `position`, `type`, `attributes` | `children`, `async`     |

- `id` — dedup key (last-push-wins), and rendered as the script's DOM `id` (for
  vendors that target `<script id="…">`). Required for inline (React never dedups
  inline scripts); for ordered external it falls back to `src`. Async externals
  dedup by `src` (matching React), so there `id` is the DOM id only.
- `position` — `"head"` (default) or `"body"`. An async script is hoisted to
  `<head>` by React regardless.
- `type` — free string: `"module"`, `"application/ld+json"`, `"text/partytown"`, …
- `attributes` — React-cased (`crossOrigin`, not `crossorigin`) and React-typed
  (`data-*`, `integrity`, `referrerPolicy`, …). Excluded: the fields the handle
  manages (`id`/`src`/`async`/`defer`/`type`/`children`/`nonce`) and all `on*`
  handlers (`onLoad`/`onError`/… — a config is serialized to the client, so a
  function can't survive; use a `"use client"` component for callbacks).

## Execution contract (read this)

React makes a `<script>` it mounts on the client INERT (it creates the element via
innerHTML, which the HTML spec never executes). So:

| Script                           | Runs on hard load              | Runs on soft (`<Link>`) navigation                    |
| -------------------------------- | ------------------------------ | ----------------------------------------------------- |
| Inline (`children`)              | Yes (it's in the initial HTML) | **No** — it is document-load only                     |
| External ordered (`defer`/plain) | Yes                            | **No** — document-load only                           |
| External `async`                 | Yes                            | **Yes** — React loads the resource on first encounter |

`<Scripts>` enforces this honestly: after hydration it **freezes** the inline +
ordered set to what was in the initial HTML, so a navigation never inserts an
inert (silently dead) `<script>`. Async configs stay reactive. Reusing an `id`
shapes the INITIAL document output (last-push-wins) — it does not re-run a script
during navigation.

> **Loader pushes meet the freeze.** A LOADER push to the Script handle
> follows the delivery race (`/loader`): it is in the initial HTML only if it
> settles before the handler barrier. A push that lands after a slow fetch
> arrives post-hydration — and for an inline/ordered script the frozen set
> means it is silently dropped. If a loader must contribute an inline script
> to the document, register it `loader(Def, { stream: "navigation" })` so the
> document render awaits the push; otherwise push from a handler (or use an
> `async` config, which stays reactive).

**Nonce caveat for soft-nav async.** The "nonce is applied automatically" claim
holds for DOCUMENT-RENDERED scripts (they carry the nonce in the SSR HTML). An
async script first encountered on a soft navigation is injected by React on the
client, where `useNonce()` is `undefined` by design (the router does not serialize
the nonce to the client — that would weaken CSP), so it has no nonce attribute. It
still loads under `'strict-dynamic'` (React's nonced runtime injects it, so the
trust propagates) — which is the recommended policy — or if your `script-src`
allows the host. A nonce-only policy without `'strict-dynamic'` would block it.

**Per-navigation behavior belongs in a client component or hook**, not in a
re-pushed inline script. The GTM demo does exactly this: a root-layout `Script`
bootstrap fires the first page_view on document load, and a `"use client"`
`<GtmPageViews>` component fires a page_view on every subsequent soft navigation.

## The inline-self-inject rule (GTM/GA4/Segment)

If an inline bootstrap must run **before** an external loader, do NOT push the
loader as a separate `{ src, async }` config: React 19 hoists a declarative
`<script async src>` to the **top** of `<head>`, above your inline bootstrap, so
the loader could run before the bootstrap. Instead let the bootstrap inject its
own loader (Google's snippet does exactly this):

```ts
function gtmBootstrap(id: string): string {
  return [
    "window.dataLayer=window.dataLayer||[];",
    'window.dataLayer.push({"gtm.start":new Date().getTime(),event:"gtm.js"});',
    `(function(d,s,i){var j=d.createElement(s);j.async=true;j.src="https://www.googletagmanager.com/gtm.js?id="+encodeURIComponent(i);var f=d.getElementsByTagName(s)[0];f.parentNode.insertBefore(j,f);})(document,"script",${JSON.stringify(id)});`,
  ].join("");
}
```

Under a `'strict-dynamic'` CSP the nonced inline script vouches for the loader it
creates, so the injected loader needs no nonce of its own.

### Per-route tagging on the first render

A route can **override** a layout's bootstrap by reusing the `id`, baking
per-route data into the FIRST (hard-load) page_view server-side — the Script
handle is collected after handlers run (parent → child, last-wins):

```ts
// root layout: generic bootstrap (handler push — always pre-barrier)
ctx.use(Script)({ id: "gtm", children: gtmBootstrap("GTM-XXXX") });
// a route: same id, with content_group baked in
ctx.use(Script)({
  id: "gtm",
  children: gtmBootstrapWith({ content_group: "blog" }),
});
```

## CSP

The nonce is automatic for document-rendered scripts. Include `'strict-dynamic'`
in `script-src` (recommended): besides letting a nonced loader vouch for the
scripts it injects, it also covers the one nonce-less case — an async script first
loaded on a soft navigation is injected client-side without a nonce (see the
caveat above), and `'strict-dynamic'` trusts it via React's nonced runtime.
Otherwise allow the vendor hosts. For GTM/GA4 (Google's wildcards): `script-src
'self' 'nonce-…' 'strict-dynamic' https://*.googletagmanager.com`, plus `img-src`
/ `connect-src` for `*.google-analytics.com` / `*.analytics.google.com`, and
`frame-src https://*.googletagmanager.com` for the GTM `<noscript>` iframe. See
[Google's CSP guide](https://developers.google.com/tag-platform/security/guides/csp).

## Not covered (do it yourself)

- **`onLoad` / `onReady` / `onError`** — callbacks can't cross the server handle
  boundary. Render your own `"use client"` component with a load listener keyed
  off the script id.
- **`<noscript>` fallbacks** (e.g. the GTM body iframe) — not a `<script>`;
  render it directly in your Document `<body>`.
- **Partytown / web-worker offloading** — push the worker config with
  `type: "text/partytown"` and wire Partytown's own nonce config manually.

A full GTM + GA4-style integration (page_view on first render + soft nav, nonce,
ecommerce events) lives in the router repository's `tests/vite-rsc-demo` app
(not shipped in this package).
