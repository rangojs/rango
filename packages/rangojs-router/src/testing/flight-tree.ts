/// <reference path="./flight-runtime.d.ts" />
/**
 * renderServerTree — REAL Flight serialize -> deserialize round-trip for unit
 * tests, returning an INSPECTABLE React element tree (not just the wire string).
 *
 * Where it sits:
 * - `renderRoute` (testing/dom): a synthetic CLIENT tree, no Flight at all.
 * - `renderToFlightString` (testing/flight): the real Flight WIRE STRING, for
 *   `toMatchFlight` substring/snapshot assertions.
 * - `renderServerTree` (here): serializes the real Flight, then deserializes it
 *   back to a React element tree you can traverse — so you can assert TYPED prop
 *   fidelity across the server/client boundary (a `Date` comes back a `Date`,
 *   not the opaque `$D...` wire encoding) and detect whether a `"use client"`
 *   component actually crossed the boundary (an `I` row) or was inlined.
 *
 * Scope (deliberate): serialize + deserialize ONLY. There is NO hydration and
 * NO interaction — the deserialized client boundaries are inert placeholders
 * carrying their props. Real interaction/hydration-mismatch testing stays at the
 * e2e tier; in-process happy-dom hydration re-tests React more than your app and
 * misses the only hydration bug worth a dedicated test (server/client divergence
 * needs a real browser).
 *
 * Runs under the `react-server` export condition, in the SAME worker as the
 * serializer (the client deserializer's react/react-dom imports are inert here
 * because deserialize-only never renders). Use it from the rsc Vitest project
 * (vitest.rsc.config.ts); name files `*.rsc-test.{ts,tsx}`.
 */

// MUST be first: defines the webpack-style globals the vendored client reads at
// module-eval time, before that client module is imported below.
import "./internal/flight-client-globals.js";
import type { ReactNode } from "react";
import { createFromReadableStream } from "@vitejs/plugin-rsc/react/browser";
import { setRequireModule } from "@vitejs/plugin-rsc/core/browser";
import * as RSDServer from "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge";
import { serializeToFlightString } from "./flight.js";
import type { RenderToFlightStringOptions } from "./flight.js";

/** Options for {@link renderServerTree}. */
export interface RenderServerTreeOptions extends RenderToFlightStringOptions {
  /**
   * The `"use client"` components reachable from the server tree, keyed by the
   * name you want each boundary to have — usually the components you already
   * import to render them: `{ clientComponents: { Counter, PriceTag } }`.
   *
   * The rsc Vitest project does NOT apply the `"use client"` transform, so a
   * plainly-imported island is just a function the serializer would render
   * server-side (and likely throw on a hook). Listing them here registers each as
   * a client reference (in place) so it serializes as a real boundary (`I` row).
   * This depends on NO filename convention — `"use client"` is marked by the
   * directive, not the name, and you already import these to render them.
   *
   * Omit it for pure server-only trees. Components already registered as client
   * references (e.g. by a transform) are left untouched. Registration is in place
   * and per-worker first-wins: a component keeps the first name it is registered
   * under for the rest of the test file.
   */
  clientComponents?: Record<string, unknown>;
}

/** Result of {@link renderServerTree}. */
export interface RenderServerTreeResult {
  /** The raw Flight wire string (so `toMatchFlight` assertions still apply). */
  flight: string;
  /**
   * The deserialized React element tree. Server elements are plain React
   * elements; each client boundary is an inert placeholder element whose `props`
   * are the real, deserialized JS values that crossed the boundary. Use
   * {@link findClientBoundaries} to locate them.
   */
  tree: unknown;
}

/** A client boundary located in a deserialized tree. */
export interface ClientBoundary {
  /** The id the boundary was registered under (the `clientComponents` key). */
  id: string;
  /** The boundary name (the `clientComponents` key). */
  name: string;
  /** The props that crossed the boundary, as real deserialized JS values. */
  props: Record<string, unknown>;
  /** The raw deserialized element (for advanced assertions). */
  element: unknown;
}

const CLIENT_REFERENCE = Symbol.for("react.client.reference");

/**
 * Tag a value as a client reference in place, unless it already is one. Accepts
 * both functions and component OBJECTS — `memo(...)` / `forwardRef(...)` exports
 * are objects at runtime, so a function-only check would skip them and the
 * serializer would inline them server-side instead of emitting an `I` row. ESM
 * live-binding identity means the server tree's own import of the same value then
 * sees the reference, so it serializes as a boundary.
 */
function registerOne(value: unknown, id: string, exportName: string): void {
  if (value === null) return;
  const kind = typeof value;
  if (kind !== "function" && kind !== "object") return;
  const ref = value as { $$typeof?: symbol; $$id?: string };
  if (ref.$$typeof === CLIENT_REFERENCE || ref.$$id) return;
  RSDServer.registerClientReference(value, id, exportName);
}

/** Register `{ name: Component }` entries, keyed by name (id === name). */
function registerClientComponents(components: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(components)) {
    registerOne(value, name, name);
  }
}

/**
 * A client manifest that resolves ANY registered client reference without
 * needing to enumerate them. `$$id` is `${id}#${exportName}`; the serializer
 * looks it up here. We omit `async`, so each `I` row is a 3-element row and the
 * deserialized boundary's payload is a clean `resolved_module` whose value is
 * `[id, [], name]` — synchronously readable by {@link findClientBoundaries}.
 */
function makeClientManifest(): unknown {
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== "string") return undefined;
        const hash = key.lastIndexOf("#");
        const id = hash >= 0 ? key.slice(0, hash) : key;
        const name = hash >= 0 ? key.slice(hash + 1) : "default";
        return { id, chunks: [], name };
      },
    },
  );
}

let loadInstalled = false;
/**
 * Install the deserialize-side module loader. For the non-async manifest above,
 * the deserializer never calls it (boundaries stay placeholders), so it throws a
 * clear error if a code path ever does try to execute a client reference.
 */
function installDeserializeLoad(): void {
  if (loadInstalled) return;
  loadInstalled = true;
  setRequireModule({
    load: (id: string) => {
      throw new Error(
        `renderServerTree does not execute client references (deserialize-only). ` +
          `A client reference "${id}" was resolved — render/interaction is the e2e tier.`,
      );
    },
  });
}

function stringToStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Serialize a server component to real Flight, then deserialize it back to an
 * inspectable React element tree. See the module header for scope.
 *
 * Must run under the `react-server` export condition.
 */
export async function renderServerTree(
  element: ReactNode,
  opts: RenderServerTreeOptions = {},
): Promise<RenderServerTreeResult> {
  if (opts.clientComponents) registerClientComponents(opts.clientComponents);
  const flight = await serializeToFlightString(
    element,
    opts,
    makeClientManifest(),
  );
  installDeserializeLoad();
  const payload = await createFromReadableStream(stringToStream(flight));
  // Resolve the top server chunk so the consumer gets their element, not a lazy.
  return { flight, tree: resolveServerLazy(unwrapPayload(payload)) };
}

/**
 * The serializer wraps the element in Rango's payload shape
 * (`{ metadata: { segments: [{ component }] } }`) to mirror the real wire
 * format. Return the consumer's own element tree, not that wrapper.
 */
function unwrapPayload(payload: unknown): unknown {
  const segment = (
    payload as { metadata?: { segments?: Array<{ component?: unknown }> } }
  )?.metadata?.segments?.[0];
  return segment && "component" in segment ? segment.component : payload;
}

interface FlightLazy {
  _payload: { status: string; value: unknown };
  _init: (payload: unknown) => unknown;
}

function asFlightLazy(node: unknown): FlightLazy | undefined {
  const candidate = node as Partial<FlightLazy> | null;
  if (
    candidate &&
    typeof candidate === "object" &&
    typeof candidate._init === "function" &&
    candidate._payload &&
    typeof (candidate._payload as { status?: unknown }).status === "string"
  ) {
    return candidate as FlightLazy;
  }
  return undefined;
}

/**
 * An async server component serializes as a deferred chunk that deserializes to
 * a lazy (`status: "resolved_model"`). Initialize it to the materialized element
 * (synchronous for a fully-drained stream; never calls a client `load`). Client
 * references (`status: "resolved_module"`) are left untouched — they are the
 * boundary markers {@link findClientBoundaries} reads.
 */
function resolveServerLazy(node: unknown): unknown {
  let current = node;
  for (let guard = 0; guard < 1000; guard++) {
    const lazy = asFlightLazy(current);
    if (!lazy || lazy._payload.status !== "resolved_model") return current;
    try {
      current = lazy._init(lazy._payload);
    } catch {
      return current;
    }
  }
  return current;
}

interface ClientBoundaryElement {
  type: { _payload: { status: string; value: unknown[] } };
  props?: Record<string, unknown>;
}

function isClientBoundaryElement(node: unknown): node is ClientBoundaryElement {
  const type = (node as { type?: unknown })?.type as
    | { _payload?: { status?: string; value?: unknown } }
    | undefined;
  const payload = type?._payload;
  return (
    !!payload &&
    payload.status === "resolved_module" &&
    Array.isArray(payload.value)
  );
}

/**
 * Walk a deserialized tree and return every client boundary, in document order,
 * each with its id, export name, and typed props. Pass `name` to keep only the
 * boundaries with that export name.
 *
 * Always returns an array (no throw on zero/many). For a single expected
 * boundary, destructure the first: `const [tag] = findClientBoundaries(tree,
 * "PriceTag")` — and assert on `.length` when the count matters (a missing name
 * yields `[]`, so `tag` would be `undefined`).
 */
export function findClientBoundaries(
  tree: unknown,
  name?: string,
): ClientBoundary[] {
  const out: ClientBoundary[] = [];
  const seen = new Set<unknown>();
  const visit = (raw: unknown): void => {
    // Materialize async-server-component chunks so we can traverse into them;
    // client-reference chunks pass through untouched.
    const node = resolveServerLazy(raw);
    if (node == null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (isClientBoundaryElement(node)) {
      const value = node.type._payload.value;
      out.push({
        id: String(value[0]),
        name: String(value[2]),
        props: node.props ?? {},
        element: node,
      });
    }
    // Recurse all own enumerable values: the tree is a deserialized payload
    // (metadata -> segments -> component -> children/props), not just nested
    // React props.
    for (const value of Object.values(node as Record<string, unknown>)) {
      visit(value);
    }
  };
  visit(tree);
  return name === undefined
    ? out
    : out.filter((boundary) => boundary.name === name);
}

/**
 * Smoke check that the vendored client deserializer subpaths still resolve. The
 * paths are private to plugin-rsc; a minor bump could relocate them. Call this in
 * a test to fail loudly with a clear message instead of an opaque import error.
 */
export function assertFlightTreeRuntimeAvailable(): void {
  if (
    typeof createFromReadableStream !== "function" ||
    typeof setRequireModule !== "function" ||
    typeof RSDServer.registerClientReference !== "function"
  ) {
    throw new Error(
      "renderServerTree runtime not available: a @vitejs/plugin-rsc client/server " +
        "subpath did not export the expected function. A plugin-rsc upgrade may have " +
        "moved react/browser, core/browser, or vendor/react-server-dom/server.edge.",
    );
  }
}
