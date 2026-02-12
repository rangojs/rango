- When writing code comments, never use icons and emojis. Keep comments technical and focused on implementation details.
- Before working on routing, run `/rango` to understand the API. Skills are in `node_modules/@rangojs/router/skills/`.
- Run the full test suite with `pnpm test` from the repo root.
- After changing router Vite plugin code (`packages/rangojs-router/src/vite/`), rebuild with `pnpm build-router` before running `pnpm dev`.

## Design Documents

Before implementing features, check the design docs for target architecture:

- `docs/design/caching.md` — Segment-level caching design (runtime cache)
- `packages/rangojs-router/docs/prerender-api-design.md` — **Pre-rendering design** (canonical). Defines the core principle (prerender = build-time cache), B segment type, BuildContext, handler eviction, storage layout, passthrough mode, runtime flow, and interaction with caching/loaders/actions.

**Pre-rendering architecture rule**: Pre-rendering is caching at build time. The worker handles every request — there are NO static .html or .rsc files served from assets. At runtime, the worker looks up stored Flight payloads (serialized segments) and passes them to the segment system, identical to a cache hit. The browser does not know if a route was pre-rendered. Read `packages/rangojs-router/docs/prerender-api-design.md` before making ANY changes to pre-rendering.
