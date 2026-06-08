# Why SSR/RSC Streaming Uses Web Streams Everywhere (Including Node)

If you're about to "speed up Node SSR" by reaching for Node streams, stop here first — this
doc is the answer to the question you're about to ask.

Both rendering layers use `renderToReadableStream` (Web Streams) in **every** runtime,
including Node. We do **not** use `renderToPipeableStream` (`react-dom/server.node`) on
Node, even though React officially recommends it there. That looks like we ignored the
docs by accident; we didn't. It's a deliberate choice, and the reasoning below is the scar
tissue from working through it.

## The constraint

Before the "why," here's the "what" — the exact pins, so you can see how little wiggle room
there actually is:

- **SSR / HTML layer** pins `react-dom/server.edge`:
  `src/vite/plugins/virtual-entries.ts:41` (the SSR virtual entry). The renderer is
  injected as a dep into the generic `createSSRHandler` (`src/ssr/index.tsx`), which only
  ever calls `renderToReadableStream`, `.allReady`, and `.pipeThrough`
  (`src/ssr/index.tsx:344`, `:354`, `:358`) — all Web Streams APIs.
- **Flight / RSC layer** uses `@vitejs/plugin-rsc/rsc` (re-exported via `src/deps/rsc.ts`),
  whose `renderToReadableStream` comes from the vendored
  `react-server-dom-webpack/server.edge`. Call site: `src/rsc/rsc-rendering.ts:163`.
- Both stream bodies are handed to `new Response(...)` as a Web `ReadableStream` via
  `createResponseWithMergedHeaders` (`src/rsc/helpers.ts:74`); RSC-only responses return
  the raw Web `rscStream` (`src/rsc/rsc-rendering.ts:202`), HTML responses return
  `htmlStream` after `pipeThrough(injectRSCPayload(...))`
  (`src/rsc/rsc-rendering.ts:217-227`).

One thing that trips people up: this isn't about Web Streams being the only thing available
on Node. `react-dom@19.x` `./server.edge` exports **only** `renderToReadableStream`, but
`./server.node` exports **both** `renderToPipeableStream` _and_ `renderToReadableStream` —
and Node 18+ ships `ReadableStream`/`TransformStream`/`TextEncoder` as globals anyway. So
the edge pin isn't a workaround for a missing API. It's there to keep a single,
runtime-identical render path.

## Why not `renderToPipeableStream` on Node

Here's the fair objection, stated plainly: React's docs recommend a per-runtime split —
`renderToPipeableStream` on Node, `renderToReadableStream` on Web/edge — and Node streams
really are faster than Web Streams _in isolation_ on Node. So why leave performance on the
table?

Two independent reasons, either of which is enough on its own:

1. **The downstream pipeline is immovably Web Streams, so a swap pays a conversion tax that
   eats the gain.** `injectRSCPayload` (from `rsc-html-stream/server`) is a Web
   `TransformStream`; the `pipeThrough` chain, the `Response` body, and the Node socket
   boundary (`srvx`, below) all require a Web stream. Swapping only the HTML render to
   `renderToPipeableStream` (a Node `Writable`) forces a Node→Web conversion
   (`Readable.toWeb`) to feed `injectRSCPayload`/`Response`. That conversion reintroduces
   the spec buffering, promises, and microtask overhead that made Web Streams slower in the
   first place — so the render-side win you just bought gets handed right back at the
   boundary.

2. **The Flight layer is not ours to change.** RSC/Flight is rendered by
   `@vitejs/plugin-rsc`'s vendored edge runtime
   (`@vitejs/plugin-rsc/vendor/react-server-dom/server.edge`). The plugin hard-pins `.edge`
   for both the `ssr` and `rsc` environments, exposes **no** config option to select a
   render API or stream type, and never imports the `server.node` vendor file it ships. You
   cannot make the _whole_ pipeline Node-streams without forking the plugin.

Put the two together and the position is: a partial (HTML-only) swap is
"forking-equivalent surgery for no reliable net win," and a full swap requires an upstream
change to `@vitejs/plugin-rsc`. There's also a quieter upside to the Web-Streams path that's
easy to undervalue — it's what makes the same build run unchanged on Node, Cloudflare
Workers, Deno, and Bun. That portability is the framework's runtime-agnostic contract, not a
happy accident.

### The Node boundary (`srvx`)

Worth knowing where the single Web→Node hop actually happens, because it's not where you'd
guess and it's not in our code. `@vitejs/plugin-rsc` adapts the Web `Response` to Node via
`srvx` (`toNodeHandler` from `srvx/node`). `srvx` drains the Web `ReadableStream` body with
`stream.getReader()` and pumps chunks into `nodeRes.write()` with `'drain'` backpressure —
a single, unavoidable Web→Node hop at the very last step. (`srvx` does have a
`stream.pipe(nodeRes)` fast path for bodies that are _already_ Node `Readable`s, but a
`.edge` render never produces one, so that branch is dead for this stack.) This boundary
lives entirely in plugin/`srvx` code, not in framework source.

## Condition resolution is correct (no edge/node mismatch)

A reasonable worry when you see "edge build running under Node" is that something is
misconfigured — that Node is accidentally pulling an edge bundle where it shouldn't. It
isn't. Running the edge build under Node is correct here, and there are three reasons it
holds together:

- The `react-server` condition is scoped to the **RSC** environment only
  (`@vitejs/plugin-rsc` sets `conditions: ["react-server", ...defaultServerConditions]` for
  the `rsc` env). The `client` and `ssr` environments inherit Vite's defaults and never see
  `react-server`.
- The SSR layer does **not** rely on runtime condition inference at all — it explicitly
  imports `react-dom/server.edge`, which resolves via the `default` export condition (no
  `react-server` in the env) to the Web-Streams edge build. There is no path where Node
  accidentally pulls the `node` build where the `edge` build is expected.
- Node and Cloudflare presets resolve **identically**; the only differences are
  bundling/deployment. A single React/react-dom instance per environment is guaranteed by
  root-level `dedupe: ["react", "react-dom"]`, asserted in
  `src/vite/__tests__/react-dedupe-config.test.ts`.

One more thing you might reach for as a reason to switch: the edge build on Node has no
built-in stream compression. True, but this pipeline does no compression at any layer
(that's an HTTP/CDN concern), so it makes no difference here.

## When this should be revisited

This isn't "never" — it's "not on principle, and only when one of these specific things
changes, and even then only with a benchmark in hand":

- `@vitejs/plugin-rsc` ships an opt-in `server.node`/pipeable Flight+SSR mode. Then a
  _coherent all-Node pipeline_ (no mid-pipeline conversion) becomes possible and the
  calculus changes.
- `rsc-html-stream/server` gains a native Node-stream `injectRSCPayload`, removing the Web
  `TransformStream` constraint on the HTML path.
- A future Node release closes the Web-vs-native stream gap to within noise — at which
  point the question is moot and the portable path wins on simplicity alone.

If someone still wants a number, the only test worth trusting is an SSR-only spike (alias
`server.edge`→`server.node`, swap to `renderToPipeableStream`, add a Node→Web shim before
`injectRSCPayload`) A/B'd against current on a many-small-component page at the real Node
version. The hypothesis to disprove is "render-side gain > boundary-conversion tax." Do not
ship the spike — it forks the Flight layer and splits the dev/prod and Node/edge test story.

References: React's per-runtime guidance —
[`renderToReadableStream`](https://react.dev/reference/react-dom/server/renderToReadableStream)
("For Node.js, use `renderToPipeableStream` instead") and
[`renderToPipeableStream`](https://react.dev/reference/react-dom/server/renderToPipeableStream)
("specific to Node.js ... edge runtimes should use `renderToReadableStream`").
