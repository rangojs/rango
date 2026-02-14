# Transform Support Matrix (`create*`)

This document defines which source shapes are transformed by Vite ID injection.

## Goals

- Keep transforms fast for common cases.
- Be explicit about unsupported patterns to avoid silent runtime failures.
- Make supported patterns stable across package and monorepo apps.

## Import Gate

The plugin exits early unless the module source contains `@rangojs/router`.
This avoids unnecessary work on unrelated files.

Aliased imports are supported for transformed APIs, e.g.
`import { createLoader as cl } from "@rangojs/router"`.

## Supported Patterns

### `createLoader`, `createHandle`, `createLocationState`

Currently supported and transformed:

```ts
export const X = createLoader(...);
export const Y = createHandle(...);
export const Z = createLocationState(...);
```

Aliased forms are also supported:

```ts
import { createLoader as cl } from "@rangojs/router";
export const X = cl(...);
```

These are transformed with stable IDs and extra runtime metadata.

### `createStaticHandler`, `createPrerenderHandler`

Supported:

- `export const X = createStaticHandler(...)`
- `export const X = createPrerenderHandler(...)`
- aliased imports are supported (e.g. `import { createStaticHandler as sh } ...`)
- inline calls (extracted to virtual modules via AST)

Example inline shape:

```ts
layout(createStaticHandler(() => <nav />));
path("/about", createPrerenderHandler(() => <div />));
```

## Currently Unsupported (strict APIs)

For `createLoader`, `createHandle`, `createLocationState`, these are not guaranteed:

- `const X = createLoader(...); export { X }`
- `export let X = createLoader(...)`
- `export var X = createLoader(...)`
- inline `createLoader(...)` call sites

Equivalent constraints apply to `createHandle` and `createLocationState`.

When these shapes are detected, the plugin emits a warning.

## Why Warnings Exist

The strict APIs currently use regex-based transform anchors that depend on:

`export const Name = createX(...)`

Warnings are intentionally noisy so unsupported shapes are found during dev/build
instead of failing at runtime with missing IDs.

## Future Direction

Planned direction is a unified AST export/call graph so strict APIs can support:

- local declaration + named export (`const X ...; export { X }`)
- alias exports (`export { X as Y }`)
- other declaration variants where safe
