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
import { createFromReadableStream } from "@vitejs/plugin-rsc/react/browser";
import { setRequireModule } from "@vitejs/plugin-rsc/core/browser";
import * as RSDServer from "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge";
import type { ReactNode } from "react";
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
  /**
   * The props that crossed the boundary, as real deserialized JS values
   * (EXCLUDES `children` — read it off {@link ClientBoundary.children}, mirroring
   * {@link FoundElement}).
   */
  props: Record<string, unknown>;
  /** The boundary's `props.children` (what was nested inside the island). */
  children: unknown;
  /** The raw deserialized element (for advanced assertions). */
  element: unknown;
}

/**
 * A selector for {@link findClientBoundaries}. Pass a string to match by export
 * name (the back-compatible form), or this object to also filter by props /
 * test id / an arbitrary predicate. All provided criteria are AND-ed.
 *
 * Only CLIENT boundaries are matched — a `data-testid` on a `"use client"`
 * island is a prop that crossed the boundary (so `testId` finds it), but a
 * `data-testid` on a plain server host element is NOT a boundary and is not
 * matched here.
 */
export interface BoundarySelector {
  /** Match the boundary's export name (same as passing a bare string). */
  name?: string;
  /** Match `props["data-testid"]` exactly (sugar over `props: { "data-testid": ... }`). */
  testId?: string;
  /**
   * Subset match: every listed prop must DEEP-EQUAL the boundary's prop of the
   * same key (Date/Map/Set/array/nested-object aware). Props not listed are
   * ignored, so `{ amount: 12.5 }` matches a boundary that also has other props.
   */
  props?: Record<string, unknown>;
  /** Arbitrary predicate, AND-ed with the criteria above. */
  where?: (boundary: ClientBoundary) => boolean;
}

/**
 * Structural equality for boundary-prop matching. Handles the value kinds that
 * survive a Flight round-trip (primitives, Date, Map, Set, Array, plain object);
 * falls back to reference identity for anything exotic.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, value] of a) {
      if (!b.has(key) || !deepEqual(value, b.get(key))) return false;
    }
    return true;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    // Deep-equal each member (not shallow has()), so Sets of equal-but-distinct
    // objects/Dates that survived deserialization still match.
    const bValues = [...b];
    for (const value of a) {
      if (!bValues.some((other) => deepEqual(value, other))) return false;
    }
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length && a.every((value, i) => deepEqual(value, b[i]))
    );
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const aKeys = Object.keys(a as object);
    const bKeys = Object.keys(b as object);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key) =>
        deepEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        ),
      )
    );
  }
  return false;
}

/** Does a boundary satisfy every criterion of an object selector? */
function matchesSelector(
  boundary: ClientBoundary,
  selector: BoundarySelector,
): boolean {
  if (selector.name !== undefined && boundary.name !== selector.name) {
    return false;
  }
  if (
    selector.testId !== undefined &&
    boundary.props["data-testid"] !== selector.testId
  ) {
    return false;
  }
  if (selector.props !== undefined) {
    for (const [key, value] of Object.entries(selector.props)) {
      if (!deepEqual(boundary.props[key], value)) return false;
    }
  }
  if (selector.where !== undefined && !selector.where(boundary)) {
    return false;
  }
  return true;
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
export function registerClientComponents(
  components: Record<string, unknown>,
): void {
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
export function makeClientManifest(): unknown {
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
  return { flight, tree: await deserializeFlight(flight) };
}

/**
 * Deserialize a Flight wire string back to an inspectable React element tree:
 * `createFromReadableStream` (vendored client), then unwrap Rango's payload
 * wrapper and resolve the top server chunk so the consumer gets their element,
 * not a lazy. Reused by renderServerTree AND renderHandler. Client references
 * stay as inert boundary markers ({@link findClientBoundaries} reads them).
 */
export async function deserializeFlight(flight: string): Promise<unknown> {
  installDeserializeLoad();
  const payload = await createFromReadableStream(stringToStream(flight));
  return resolveServerLazy(unwrapPayload(payload));
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
 * each with its id, export name, and typed props. The optional second arg
 * filters the result:
 * - a STRING matches by export name (`findClientBoundaries(tree, "PriceTag")`);
 * - a {@link BoundarySelector} object filters by `name` / `testId` / `props`
 *   (subset deep-equal) / `where` predicate, AND-ed
 *   (`findClientBoundaries(tree, { testId: "price-tag" })`).
 *
 * Always returns an array (no throw on zero/many). For a single expected
 * boundary, destructure the first: `const [tag] = findClientBoundaries(tree,
 * "PriceTag")` — and assert on `.length` when the count matters (no match
 * yields `[]`, so `tag` would be `undefined`).
 */
/**
 * Walk a deserialized tree, calling `visit` on every materialized object node in
 * document order (parent before children). Async-server-component chunks are
 * materialized via resolveServerLazy so the walk descends into them; arrays are
 * traversed but not themselves visited. Shared by findClientBoundaries and
 * findElements.
 */
function walkNodes(tree: unknown, visit: (node: object) => void): void {
  const seen = new Set<unknown>();
  const recur = (raw: unknown): void => {
    const node = resolveServerLazy(raw);
    if (node == null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) recur(child);
      return;
    }
    visit(node);
    // Recurse all own enumerable values: the tree is a deserialized payload
    // (metadata -> segments -> component -> children/props), not just nested
    // React props.
    for (const value of Object.values(node as Record<string, unknown>)) {
      recur(value);
    }
  };
  recur(tree);
}

export function findClientBoundaries(
  tree: unknown,
  selector?: string | BoundarySelector,
): ClientBoundary[] {
  const out: ClientBoundary[] = [];
  walkNodes(tree, (node) => {
    if (isClientBoundaryElement(node)) {
      const value = node.type._payload.value;
      const { children, ...rest } = (node.props ?? {}) as Record<
        string,
        unknown
      >;
      out.push({
        id: String(value[0]),
        name: String(value[2]),
        props: rest,
        children,
        element: node,
      });
    }
  });
  if (selector === undefined) return out;
  if (typeof selector === "string") {
    return out.filter((boundary) => boundary.name === selector);
  }
  return out.filter((boundary) => matchesSelector(boundary, selector));
}

/** A server/host element located in a deserialized tree by {@link findElements}. */
export interface FoundElement {
  /** The host tag name (`"article"`, `"h2"`). Always a host element. */
  tag: string;
  /** The element's props, as real deserialized JS values (excludes `children`). */
  props: Record<string, unknown>;
  /** The element's `props.children` (the rendered child tree), for convenience. */
  children: unknown;
  /** Concatenated text content of this element's subtree. */
  text: string;
  /** The raw deserialized element (for advanced assertions). */
  element: unknown;
}

/**
 * A selector for {@link findElements}. Pass a string to match a host tag name
 * (`"h2"`), or this object for finer matches. All provided criteria are AND-ed.
 *
 * Mirrors {@link BoundarySelector} but keys on `tag` (the host tag) rather than
 * `name` (a client component's export identity) — by design, since a host element
 * has no component name. It also adds `text`, which a boundary selector lacks: a
 * host element has rendered text, whereas a client boundary is an inert
 * placeholder with no rendered children to match against.
 */
export interface ElementSelector {
  /** Match the host tag name (`"article"`, `"h2"`). */
  tag?: string;
  /** Match `props["data-testid"]` exactly. */
  testId?: string;
  /** Subset deep-equal match on props (Date/Map/Set/array/nested aware). */
  props?: Record<string, unknown>;
  /** Match the element's text content (substring for a string, `.test()` for a RegExp). */
  text?: string | RegExp;
  /** Arbitrary predicate, AND-ed with the criteria above. */
  where?: (element: FoundElement) => boolean;
}

// React 19 stamps elements with `react.transitional.element`; `react.element` is
// the React 18 symbol. Accept both so the check is robust across React majors.
// This `$$typeof` test is load-bearing: it distinguishes a real element from a
// plain payload object that merely has a string `type` field (e.g. an input's
// `props` object `{ type: "text" }`), which would otherwise look like a host element.
const REACT_ELEMENT = Symbol.for("react.element");
const REACT_TRANSITIONAL_ELEMENT = Symbol.for("react.transitional.element");

/** Is a node a React element (host or component), as opposed to a plain object? */
function isReactElement(
  node: object,
): node is { type: unknown; props?: Record<string, unknown> } {
  const tag = (node as { $$typeof?: symbol }).$$typeof;
  return (
    (tag === REACT_ELEMENT || tag === REACT_TRANSITIONAL_ELEMENT) &&
    "type" in node
  );
}

/**
 * Concatenate the text content of a deserialized node's subtree — every string
 * and number leaf, in document order, space-free (`<h2>Wine {2}</h2>` ->
 * `"Wine 2"` only if the source had the space). Use it to assert rendered text
 * without reaching for `JSON.stringify(tree).toContain(...)`.
 */
export function textContent(node: unknown): string {
  let out = "";
  const recur = (raw: unknown): void => {
    const value = resolveServerLazy(raw);
    if (value == null || typeof value === "boolean") return;
    if (typeof value === "string") {
      out += value;
      return;
    }
    if (typeof value === "number") {
      out += String(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) recur(child);
      return;
    }
    if (typeof value === "object") {
      // A React element: descend into its children only (not props/type), so a
      // string-valued prop like className is not counted as text.
      if (isReactElement(value)) {
        recur((value.props as { children?: unknown })?.children);
      }
    }
  };
  recur(node);
  return out;
}

/**
 * Walk a deserialized tree and return every SERVER/HOST element (the output a
 * server component rendered), in document order. The optional second arg filters:
 * - a STRING matches a host tag name (`findElements(tree, "h2")`);
 * - an {@link ElementSelector} filters by `tag` / `testId` / `props` (subset
 *   deep-equal) / `text` (substring or RegExp) / `where`, AND-ed.
 *
 * Caveat: server COMPONENTS do not survive Flight as identities — they are
 * executed during serialization, so only the host elements they produced remain.
 * Match those host elements (by tag/props/text), not the component function. For
 * CLIENT islands (which DO keep identity) use {@link findClientBoundaries}.
 *
 * Always returns an array (destructure the first for a single expected match).
 */
export function findElements(
  tree: unknown,
  selector?: string | ElementSelector,
): FoundElement[] {
  const out: FoundElement[] = [];
  walkNodes(tree, (node) => {
    // Host elements only (typeof type === "string"). Excludes: client boundaries
    // (type is a lazy module placeholder -> findClientBoundaries), fragments and
    // other component elements (type is a Symbol/function), and plain payload
    // objects (isReactElement guards against an object whose `type` is a string
    // prop, like an input's `{ type: "text" }`).
    if (!isReactElement(node) || typeof node.type !== "string") return;
    const props = (node.props ?? {}) as Record<string, unknown>;
    const { children, ...rest } = props;
    out.push({
      tag: node.type,
      props: rest,
      children,
      text: textContent(node),
      element: node,
    });
  });
  if (selector === undefined) return out;
  if (typeof selector === "string") {
    return out.filter((element) => element.tag === selector);
  }
  return out.filter((element) => matchesElementSelector(element, selector));
}

/** Does a found element satisfy every criterion of an object selector? */
function matchesElementSelector(
  element: FoundElement,
  selector: ElementSelector,
): boolean {
  if (selector.tag !== undefined && element.tag !== selector.tag) return false;
  if (
    selector.testId !== undefined &&
    element.props["data-testid"] !== selector.testId
  ) {
    return false;
  }
  if (selector.props !== undefined) {
    for (const [key, value] of Object.entries(selector.props)) {
      if (!deepEqual(element.props[key], value)) return false;
    }
  }
  if (selector.text !== undefined) {
    const matched =
      typeof selector.text === "string"
        ? element.text.includes(selector.text)
        : selector.text.test(element.text);
    if (!matched) return false;
  }
  if (selector.where !== undefined && !selector.where(element)) return false;
  return true;
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
