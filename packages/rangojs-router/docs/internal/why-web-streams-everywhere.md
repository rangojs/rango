# Why SSR/RSC Streaming Uses Web Streams Everywhere (Including Node)

Both rendering layers use `renderToReadableStream` (Web Streams) in **every**
runtime, including Node. We do **not** use `renderToPipeableStream`
(`react-dom/server.node`) on Node, even though React officially recommends it
there. This is intentional. Future attempts to "speed up Node SSR" by switching
to Node streams should read this first.

## The constraint

- **SSR / HTML layer** pins `react-dom/server.edge`:
  `src/vite/plugins/virtual-entries.ts:41` (the SSR virtual entry). The renderer
  is injected as a dep into the generic `createSSRHandler` (`src/ssr/index.tsx`),
  which only ever calls `renderToReadableStream`, `.allReady`, and `.pipeThrough`
  (`src/ssr/index.tsx:344`, `:354`, `:358`) — all Web Streams APIs.
- **Flight / RSC layer** uses `@vitejs/plugin-rsc/rsc` (re-exported via
  `src/deps/rsc.ts`), whose `renderToReadableStream` comes from the vendored
  `react-server-dom-webpack/server.edge`. Call site: `src/rsc/rsc-rendering.ts:197`.
- Both stream bodies are handed to `new Response(...)` as a Web `ReadableStream`
  via `createResponseWithMergedHeaders` (`src/rsc/helpers.ts:117`); RSC-only
  responses return the raw Web `rscStream` (`src/rsc/rsc-rendering.ts:240`), HTML
  responses return `htmlStream` after `pipeThrough(injectRSCPayload(...))`
  (`src/ssr/index.tsx:359`).

`react-dom@19.x` `./server.edge` exports **only** `renderToReadableStream`.
`./server.node` exports **both** `renderToPipeableStream` _and_
`renderToReadableStream` — so the edge pin is not about Web Streams availability
(Node 18+ ships `ReadableStream`/`TransformStream`/`TextEncoder` as globals); it
is about keeping a single, runtime-identical render path.

## Why not `renderToPipeableStream` on Node

React's docs recommend a per-runtime split — `renderToPipeableStream` on Node,
`renderToReadableStream` on Web/edge — and Node streams are genuinely faster than
Web Streams _in isolation_ on Node. We still don't adopt it, for two independent
reasons, either of which is sufficient:

1. **The downstream pipeline is immovably Web Streams, so a swap pays a
   conversion tax that eats the gain.** `injectRSCPayload` (from
   `rsc-html-stream/server`) is a Web `TransformStream`; the `pipeThrough` chain,
   the `Response` body, and the Node socket boundary (`srvx`, below) all require a
   Web stream. Swapping only the HTML render to `renderToPipeableStream` (a Node
   `Writable`) forces a Node→Web conversion (`Readable.toWeb`) to feed
   `injectRSCPayload`/`Response`. That conversion reintroduces the spec buffering,
   promises, and microtask overhead that made Web Streams slower in the first
   place — the render-side win is handed back at the boundary.

2. **The Flight layer is not ours to change.** RSC/Flight is rendered by
   `@vitejs/plugin-rsc`'s vendored edge runtime
   (`@vitejs/plugin-rsc/vendor/react-server-dom/server.edge`). The plugin
   hard-pins `.edge` for both the `ssr` and `rsc` environments, exposes **no**
   config option to select a render API or stream type, and never imports the
   `server.node` vendor file it ships. You cannot make the _whole_ pipeline
   Node-streams without forking the plugin.

A partial (HTML-only) swap is therefore "forking-equivalent surgery for no
reliable net win," and a full swap requires an upstream change to
`@vitejs/plugin-rsc`. The portable Web-Streams path is also what makes the same
build run unchanged on Node, Cloudflare Workers, Deno, and Bun — the framework's
runtime-agnostic contract.

### The Node boundary (`srvx`)

`@vitejs/plugin-rsc` adapts the Web `Response` to Node via `srvx` (`toNodeHandler`
from `srvx/node`). `srvx` drains the Web `ReadableStream` body with
`stream.getReader()` and pumps chunks into `nodeRes.write()` with `'drain'`
backpressure — a single, unavoidable Web→Node hop at the very last step. (`srvx`
has a `stream.pipe(nodeRes)` fast path for bodies that are _already_ Node
`Readable`s, but a `.edge` render never produces one, so that branch is dead for
this stack.) This boundary lives entirely in plugin/`srvx` code, not in framework
source.

## Condition resolution is correct (no edge/node mismatch)

Running the edge build under Node is correct, not a misconfiguration:

- The `react-server` condition is scoped to the **RSC** environment only
  (`@vitejs/plugin-rsc` sets `conditions: ["react-server", ...defaultServerConditions]`
  for the `rsc` env). The `client` and `ssr` environments inherit Vite's defaults
  and never see `react-server`.
- The SSR layer does **not** rely on runtime condition inference at all — it
  explicitly imports `react-dom/server.edge`, which resolves via the `default`
  export condition (no `react-server` in the env) to the Web-Streams edge build.
  There is no path where Node accidentally pulls the `node` build where the `edge`
  build is expected.
- Node and Cloudflare presets resolve **identically**; the only differences are
  bundling/deployment. A single React/react-dom instance per environment is
  guaranteed by root-level `dedupe: ["react", "react-dom"]`, asserted in
  `src/vite/__tests__/react-dedupe-config.test.ts`.

The edge build on Node has no built-in stream compression, but this pipeline does
no compression at any layer (that is an HTTP/CDN concern), so it makes no
difference here.

## When this should be revisited

Only if one of these changes — and only then with a benchmark, not on principle:

- `@vitejs/plugin-rsc` ships an opt-in `server.node`/pipeable Flight+SSR mode.
  Then a _coherent all-Node pipeline_ (no mid-pipeline conversion) becomes
  possible and the calculus changes.
- `rsc-html-stream/server` gains a native Node-stream `injectRSCPayload`,
  removing the Web `TransformStream` constraint on the HTML path.
- A future Node release closes the Web-vs-native stream gap to within noise — at
  which point the question is moot and the portable path wins on simplicity alone.

If someone still wants a number, the only honest test is an SSR-only spike
(alias `server.edge`→`server.node`, swap to `renderToPipeableStream`, add a
Node→Web shim before `injectRSCPayload`) A/B'd against current on a
many-small-component page at the real Node version. The hypothesis to disprove is
"render-side gain > boundary-conversion tax." Do not ship the spike; it forks the
Flight layer and splits the dev/prod and Node/edge test story.

References: React's per-runtime guidance —
[`renderToReadableStream`](https://react.dev/reference/react-dom/server/renderToReadableStream)
("For Node.js, use `renderToPipeableStream` instead") and
[`renderToPipeableStream`](https://react.dev/reference/react-dom/server/renderToPipeableStream)
("specific to Node.js ... edge runtimes should use `renderToReadableStream`").
