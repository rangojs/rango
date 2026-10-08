/**
 * Dev-only audit of what the router hands its Suspense boundaries and of the
 * tree those boundaries sit in (docs/internal/suspense-contract.md). Every
 * call site is behind `process.env.NODE_ENV !== "production"`, so a build
 * carries none of this module (tools/check-bundle-guards.mjs), and the audit
 * runs only where INTERNAL_RANGO_SUSPENSE_AUDIT is set: this repo's e2e apps
 * and the router's own tests, never a consumer's dev server.
 *
 * React warns about none of this: its uncached-promise warning covers a
 * promise created during render (a different thenable on a replay of one
 * render attempt), never a boundary handed a different promise by a later
 * render.
 *
 * The audit never attaches a reaction to a promise it is handed: that marks a
 * rejected promise handled, and dev would stop raising the unhandled
 * rejection a build raises. It reads the `status` React's use() and the
 * Flight client leave on a thenable instead.
 *
 * No React import: segment-system.tsx is evaluated outside the browser too.
 * The hooks are in suspense-audit-react.tsx.
 *
 * Imports nothing a product module does not already import first: a new
 * static import here, or in suspense-audit-react.tsx, moves that module
 * earlier in the client router chunk (route-content-wrapper.tsx imports both)
 * and a build stops matching main byte for byte, although every audit call
 * is folded away. Measured in cloudflare-basic for handles/is-thenable.ts and
 * browser/react/context.ts.
 */
import { INTERNAL_RANGO_DEBUG } from "./internal-debug.js";
import { INTERNAL_RANGO_SUSPENSE_AUDIT } from "./internal-suspense-audit.js";

export type SuspenseAuditKind =
  | "swap"
  | "untracked"
  | "idle-fallback"
  | "resuspended"
  | "remount"
  | "drift"
  | "uncaused"
  | "mutated";

/** What may hand React a tree (I6). */
export type TreeUpdateCause =
  | "navigation"
  | "popstate"
  | "stale-revalidation"
  | "action"
  | "error"
  | "hmr";

export interface SuspenseAuditEvent {
  /** I1 swap, I2 untracked, I3 idle-fallback and resuspended, I4 remount, I5 drift, I6 uncaused, I7 mutated. */
  kind: SuspenseAuditKind;
  /** `content:<segment id>`, `loaders:<outlet key>`, `outlet:<segment id>`, `read:<loader id>`, `segment:<segment id>`. */
  boundary: string;
  detail: string;
  url: string;
  at: number;
}

export interface SuspenseAuditReport {
  swaps: number;
  untracked: number;
  idleFallbacks: number;
  resuspended: number;
  remounts: number;
  drifts: number;
  uncaused: number;
  mutations: number;
  /**
   * Not a violation: fallbacks the router cannot attribute. Nothing it handed
   * the boundary was a promise React read, so the content's own suspension
   * put the fallback up: an app's use(), a React.lazy, a client reference.
   */
  unattributedFallbacks: number;
  /** Not a violation: tree updates React was handed, by cause ("none" without one). */
  treeUpdates: Record<string, number>;
  /**
   * Not a violation: the distinct thenables each boundary or read was handed.
   * One per value it waited for; two for one navigation is a gate replaced
   * by the real promise.
   */
  readonly handed: Record<string, number>;
  /**
   * Not a violation: fallbacks shown over content on screen while what the
   * boundary waits for was pending. An urgent commit does that by design.
   */
  shownWhilePending: number;
  /** Mounts per boundary since the document loaded. */
  readonly mounts: Record<string, number>;
  /** The last events, oldest first. */
  events: SuspenseAuditEvent[];
  reset(): void;
}

/** One boundary, or one `useLoader` read. Lives as long as its fiber. */
export interface BoundaryAudit {
  boundary: string;
  /** Segment id, for the place in the tree. */
  segmentId: string;
  /** The React key the segment was mounted under (I4 identity). */
  key: string;
  /** 0 until the boundary is on screen. */
  mountId: number;
  /** Last value a render ran with, and the URL it ran under. */
  seen: unknown;
  hasSeen: boolean;
  seenUrl: string;
  /** Last value a commit carried. */
  committed: unknown;
  hasCommitted: boolean;
  /** What else the boundary's content waits for: per-loader streams, nodes. */
  streams: Record<string, unknown> | undefined;
  nodes: unknown;
  /** The content has been on screen. */
  revealed: boolean;
  /** The fallback's effect was cleaned up in this task (auditFallback). */
  fallbackGone: boolean;
}

const PREFIX = "[rango][suspense]";
// What a failing test prints; older events repeat what the counters say.
const MAX_EVENTS = 50;
// Boundary names carry params: a long dev session must not grow without bound.
const MAX_BOUNDARIES = 500;
// One fallback check's client-reference scan; types are visited first.
const MAX_SCAN = 400;

type Tracked = PromiseLike<unknown> & { status?: string; value?: unknown };

// handles/is-thenable.ts, inlined (see the header).
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

// A Flight chunk extends Promise.prototype with its own `then` and always
// carries a status.
function isNative(value: PromiseLike<unknown>): boolean {
  return value.then === Promise.prototype.then;
}

// Set by React's use() on a thenable it has read, and by the Flight client
// on every chunk. Undefined on a native promise React has not read.
function statusOf(value: unknown): string | undefined {
  return isThenable(value) ? (value as Tracked).status : undefined;
}

function isPending(value: unknown): boolean {
  const status = statusOf(value);
  return status === "pending" || status === "blocked" || status === "halted";
}

// What a settled thenable holds, where the audit can know it.
function settledValue(value: unknown): unknown {
  if (!isThenable(value)) return value;
  const tracked = value as Tracked;
  return tracked.status === "fulfilled" ? tracked.value : undefined;
}

const LAZY = Symbol.for("react.lazy");

/**
 * A node that names a client reference whose module is still loading. In dev
 * @vitejs/plugin-rsc tags client reference ids per render, so the first
 * render of every fresh payload meets them blocked for a few milliseconds
 * and a boundary with nothing pending from the router shows its fallback.
 * That is the bundler's doing, not a value the router handed over.
 */
function hasBlockedReference(root: unknown): boolean {
  const stack: unknown[] = [root];
  let visited = 0;
  while (stack.length > 0 && visited++ < MAX_SCAN) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }
    const lazy = node as { $$typeof?: unknown; _payload?: { status?: string } };
    if (lazy.$$typeof === LAZY) {
      const status = lazy._payload?.status;
      if (status === "pending" || status === "blocked") return true;
      continue;
    }
    const element = node as { type?: unknown; props?: Record<string, unknown> };
    if (element.props === null || typeof element.props !== "object") continue;
    for (const name in element.props) stack.push(element.props[name]);
    // Popped first: a large list prop must not use the scan up before it.
    stack.push(element.type);
  }
  return false;
}

function describe(value: unknown): string {
  if (isThenable(value)) {
    return `${isNative(value) ? "promise" : "Flight chunk"} (${statusOf(value) ?? "unread"})`;
  }
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null || value === undefined) return String(value);
  return typeof value === "object" ? "node" : typeof value;
}

function href(): string {
  return typeof location === "undefined"
    ? ""
    : location.pathname + location.search;
}

// The newest MAX_BOUNDARIES keys, oldest dropped first.
function setBounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_BOUNDARIES) map.delete(map.keys().next().value!);
}

const handedCounts = new Map<string, number>();
const mountCounts = new Map<string, number>();
// By boundary, not by record: a reader that suspends while mounting keeps
// no record between its attempts.
const handedSeen = new Map<string, WeakSet<object>>();

let report: SuspenseAuditReport | undefined;

function getReport(): SuspenseAuditReport {
  if (report) return report;
  const created: SuspenseAuditReport = {
    swaps: 0,
    untracked: 0,
    idleFallbacks: 0,
    resuspended: 0,
    remounts: 0,
    drifts: 0,
    uncaused: 0,
    mutations: 0,
    unattributedFallbacks: 0,
    treeUpdates: {},
    get handed() {
      return Object.fromEntries(handedCounts);
    },
    shownWhilePending: 0,
    get mounts() {
      return Object.fromEntries(mountCounts);
    },
    events: [],
    reset() {
      created.swaps = 0;
      created.untracked = 0;
      created.idleFallbacks = 0;
      created.resuspended = 0;
      created.remounts = 0;
      created.drifts = 0;
      created.uncaused = 0;
      created.mutations = 0;
      created.unattributedFallbacks = 0;
      created.treeUpdates = {};
      handedCounts.clear();
      handedSeen.clear();
      created.shownWhilePending = 0;
      created.events = [];
    },
  };
  report = created;
  if (typeof window !== "undefined") {
    (
      window as unknown as { __rangoSuspenseAudit?: SuspenseAuditReport }
    ).__rangoSuspenseAudit = created;
  }
  return created;
}

type Counter =
  | "swaps"
  | "untracked"
  | "idleFallbacks"
  | "resuspended"
  | "remounts"
  | "drifts"
  | "uncaused"
  | "mutations";

const RULES: Record<SuspenseAuditKind, [invariant: string, counter: Counter]> =
  {
    swap: ["I1", "swaps"],
    untracked: ["I2", "untracked"],
    "idle-fallback": ["I3", "idleFallbacks"],
    resuspended: ["I3", "resuspended"],
    remount: ["I4", "remounts"],
    drift: ["I5", "drifts"],
    uncaused: ["I6", "uncaused"],
    mutated: ["I7", "mutations"],
  };

function violate(
  kind: SuspenseAuditKind,
  boundary: string,
  detail: string,
): void {
  const [invariant, counter] = RULES[kind];
  const r = getReport();
  r[counter] += 1;
  r.events.push({ kind, boundary, detail, url: href(), at: performance.now() });
  if (r.events.length > MAX_EVENTS) r.events.shift();
  console.error(`${PREFIX} ${invariant} ${kind} at ${boundary}: ${detail}`);
}

// Every hand-over, mount and fallback, for a debug run to read back. Call
// sites test INTERNAL_RANGO_DEBUG first, so the data is not built otherwise.
function trace(type: string, data: Record<string, unknown>): void {
  console.log(
    `${PREFIX}[trace] ${JSON.stringify({ type, ...data, url: href(), at: Math.round(performance.now()) })}`,
  );
}

// One microtask for every job the audit defers in a task.
const jobs: Array<() => void> = [];

function later(job: () => void): void {
  jobs.push(job);
  if (jobs.length === 1) queueMicrotask(runJobs);
}

function runJobs(): void {
  for (const job of jobs.splice(0)) job();
}

// After React's own reaction to a thenable it read in this task: the first
// job runs before it, the second after.
function afterMicrotasks(run: () => void): void {
  later(() => later(run));
}

export function createBoundaryAudit(
  boundary: string,
  segmentId: string,
): BoundaryAudit {
  return {
    boundary,
    segmentId,
    key: segmentId,
    mountId: 0,
    seen: undefined,
    hasSeen: false,
    seenUrl: "",
    committed: undefined,
    hasCommitted: false,
    streams: undefined,
    nodes: undefined,
    revealed: false,
    fallbackGone: false,
  };
}

function countHanded(boundary: string, value: unknown): void {
  if (!isThenable(value)) return;
  let seen = handedSeen.get(boundary);
  if (!seen) setBounded(handedSeen, boundary, (seen = new WeakSet()));
  if (seen.has(value)) return;
  seen.add(value);
  getReport();
  setBounded(handedCounts, boundary, (handedCounts.get(boundary) ?? 0) + 1);
}

/**
 * Render phase: the value this render hands the boundary.
 *
 * I1: a boundary on screen was handed a thenable that is still pending, and
 * is handed another one that is not already settled, for the same URL. React
 * starts waiting again. A settled replacement is read at once, and another
 * URL is another navigation: both are exempt.
 * I2: a boundary whose content has been on screen is handed a native promise
 * React has not read, and React finds it settled when it reads it. A render
 * that cannot wait suspends on it and commits the fallback over the content,
 * which React keeps up for 300 ms. Judged from the status React leaves on
 * the promise when it reads it in the same task.
 */
export function auditHandover(rec: BoundaryAudit, value: unknown): void {
  if (typeof window === "undefined") return;
  countHanded(rec.boundary, value);
  // A replay, or a re-render of the parent, hands the same object.
  if (rec.hasSeen && rec.seen === value) return;
  const previous = rec.seen;
  const hadPrevious = rec.hasSeen;
  const url = href();
  const sameUrl = rec.seenUrl === url;
  rec.seen = value;
  rec.hasSeen = true;
  rec.seenUrl = url;
  const unread =
    isThenable(value) && isNative(value) && statusOf(value) === undefined;
  if (INTERNAL_RANGO_DEBUG) {
    trace("handover", {
      boundary: rec.boundary,
      mountId: rec.mountId,
      revealed: rec.revealed,
      handed: describe(value),
      previous: hadPrevious ? describe(previous) : "none",
      previousPending: hadPrevious && isPending(previous),
      sameUrl,
    });
  }
  if (
    rec.mountId > 0 &&
    hadPrevious &&
    sameUrl &&
    isPending(previous) &&
    isThenable(value)
  ) {
    const swapped = (): void => {
      // Settled by now: React reads it without waiting again.
      if (!isPending(value) || !isPending(previous)) return;
      violate(
        "swap",
        rec.boundary,
        `handed ${describe(value)} while ${describe(previous)} was still pending`,
      );
    };
    if (unread) afterMicrotasks(swapped);
    else swapped();
  }
  if (rec.revealed && unread) {
    afterMicrotasks(() => {
      if (statusOf(value) !== "fulfilled") return;
      violate(
        "untracked",
        rec.boundary,
        "content on screen was handed a settled promise React has not read; hand the value itself",
      );
    });
  }
}

/** Commit phase: what the boundary on screen now reads. */
export function auditCommit(
  rec: BoundaryAudit,
  value: unknown,
  streams?: Record<string, unknown>,
  nodes?: unknown,
): void {
  rec.committed = value;
  rec.hasCommitted = true;
  rec.streams = streams;
  rec.nodes = nodes;
}

export function auditReveal(rec: BoundaryAudit): void {
  if (!rec.revealed && INTERNAL_RANGO_DEBUG) {
    trace("reveal", { boundary: rec.boundary, mountId: rec.mountId });
  }
  rec.revealed = true;
}

/** One `useLoader` read on screen: it has a mount and reveals with it. */
export function auditRead(rec: BoundaryAudit, stream: unknown): void {
  rec.mountId = 1;
  auditCommit(rec, stream);
  auditReveal(rec);
}

let streamProbe: (() => boolean) | undefined;

/**
 * How the audit learns that a payload is still streaming: the event
 * controller, set at boot (browser/rsc-router.tsx). Not read from
 * NavigationStoreContext in AuditedFallback: see the header.
 */
export function setSuspenseAuditStreamProbe(probe: () => boolean): void {
  streamProbe = probe;
}

function streamOpen(): boolean {
  if (typeof document !== "undefined" && document.readyState === "loading") {
    return true;
  }
  return streamProbe?.() === true;
}

/**
 * I3: the boundary's fallback is on screen with nothing to wait for: nothing
 * the router handed the boundary is pending, no payload is streaming and no
 * client reference is loading. `idle-fallback` on a boundary new to the page,
 * `resuspended` when the fallback replaced content that had been on screen.
 *
 * Reported only when the router can own the fallback: it handed the boundary
 * a native promise React has read. A boundary handed values alone suspended
 * on something inside its content (an app's use(), a React.lazy), which is
 * counted as `unattributedFallbacks` and not reported.
 *
 * A fallback over content on screen while something is pending is counted
 * (`shownWhilePending`) and not reported: an urgent commit does that by
 * design (transition({ when }) gated off, #995), and so does dev while a
 * client reference loads.
 */
export function auditFallback(rec: BoundaryAudit): () => void {
  const shownAt = performance.now();
  const revealed = rec.revealed;
  // StrictMode runs this effect, its cleanup and the effect again in one
  // task, some time after the commit: the second run is the same fallback,
  // and what it waited for may have settled since.
  if (!rec.fallbackGone) {
    afterMicrotasks(() => {
      const handed = rec.hasCommitted ? rec.committed : rec.seen;
      const values = rec.streams
        ? [handed, ...Object.values(rec.streams)]
        : [handed];
      const waiting = values.some(isPending);
      const streaming = !waiting && streamOpen();
      const owned = values.some(
        (value) =>
          isThenable(value) && isNative(value) && statusOf(value) !== undefined,
      );
      const loading =
        !waiting &&
        !streaming &&
        owned &&
        (hasBlockedReference(settledValue(handed)) ||
          hasBlockedReference(rec.nodes));
      if (INTERNAL_RANGO_DEBUG) {
        trace("fallback", {
          boundary: rec.boundary,
          mountId: rec.mountId,
          revealed,
          waiting,
          streaming,
          owned,
          loading,
          handed: describe(handed),
        });
      }
      const r = getReport();
      if (waiting || streaming || loading) {
        if (revealed) r.shownWhilePending += 1;
        return;
      }
      if (!owned) {
        r.unattributedFallbacks += 1;
        return;
      }
      if (revealed) {
        violate(
          "resuspended",
          rec.boundary,
          "the fallback replaced content on screen with nothing pending",
        );
      } else {
        violate(
          "idle-fallback",
          rec.boundary,
          "the fallback mounted with nothing pending",
        );
      }
    });
  }
  return () => {
    rec.fallbackGone = true;
    later(() => {
      rec.fallbackGone = false;
    });
    if (INTERNAL_RANGO_DEBUG) {
      trace("fallback-gone", {
        boundary: rec.boundary,
        mountId: rec.mountId,
        ms: Math.round(performance.now() - shownAt),
      });
    }
  };
}

/** One renderSegments call, collected while it builds. */
export interface TreeAudit {
  /** Segment ids, leaf first while building, root first once finished. */
  order: string[];
  keys: Map<string, string>;
  types: Map<string, string>;
  chains: Map<string, string[]>;
  /** Segments this tree remounts by the documented rules. */
  replaced: Set<string>;
  /** The segment objects the tree is built from (I7), until it is held. */
  segments: object[];
}

/** The tree React holds: what I4, I5 and I7 compare with. */
let held: TreeAudit | undefined;
// Every finished tree by the root renderSegments returned, until an emit
// hands that root to React. A tree that is never emitted (an aborted
// navigation's) is never held.
const builtTrees = new WeakMap<object, TreeAudit>();
// A root emitted as a promise (HMR): held once React's use() has read it.
let pendingRoot: PromiseLike<unknown> | undefined;
// I7: the fields of each segment object of the held tree, at hand-over.
const handedFields = new WeakMap<object, Record<string, unknown>>();

function heldTree(): TreeAudit | undefined {
  if (pendingRoot) {
    const status = statusOf(pendingRoot);
    if (status === "fulfilled") {
      const root = (pendingRoot as Tracked).value;
      pendingRoot = undefined;
      const tree =
        root !== null && typeof root === "object"
          ? builtTrees.get(root)
          : undefined;
      if (tree) hold(tree);
    } else if (status === "rejected") {
      pendingRoot = undefined;
    }
  }
  return held;
}

// The router's wrapper components, by function name. A boundary component
// and its dev variant (route-content-wrapper.tsx, outlet-provider.tsx) are
// one link, named after the product component.
const WRAPPERS = new Map([
  ["MountContextProvider", "MountContextProvider"],
  ["LoaderBoundary", "LoaderBoundary"],
  ["AuditedLoaderBoundary", "LoaderBoundary"],
  ["OutletProvider", "OutletProvider"],
  ["AuditedOutletProvider", "OutletProvider"],
  ["StreamedLoaderErrorBoundary", "StreamedLoaderErrorBoundary"],
  ["RouteContentWrapper", "RouteContentWrapper"],
  ["AuditedRouteContent", "RouteContentWrapper"],
]);

function wrapperName(type: unknown): string | undefined {
  if (typeof type === "function") return WRAPPERS.get(type.name);
  if (typeof type === "symbol") {
    return type.description === "react.view_transition"
      ? "ViewTransition"
      : undefined;
  }
  return undefined;
}

interface ElementLike {
  type: unknown;
  key: string | null;
  props: { children?: unknown };
}

function isElement(node: unknown): node is ElementLike {
  return (
    node !== null &&
    typeof node === "object" &&
    "type" in node &&
    "props" in node &&
    typeof (node as ElementLike).props === "object"
  );
}

// The router's own wrappers from a segment's outermost element down to its
// content: `Type#key` per link.
function wrapperChain(node: unknown): string[] {
  const chain: string[] = [];
  let current = node;
  while (isElement(current)) {
    const name = wrapperName(current.type);
    if (!name) break;
    chain.push(current.key === null ? name : `${name}#${current.key}`);
    current = current.props.children;
  }
  return chain;
}

export function startTreeAudit(): TreeAudit | undefined {
  if (!INTERNAL_RANGO_SUSPENSE_AUDIT || typeof window === "undefined") {
    return undefined;
  }
  getReport();
  // A root emitted as a promise is held before this tree reads its segments.
  heldTree();
  return {
    order: [],
    keys: new Map(),
    types: new Map(),
    chains: new Map(),
    replaced: new Set(),
    segments: [],
  };
}

/**
 * I7: a segment object of the tree React holds was written since it was
 * handed over. Judged when the next tree is built from it, where
 * renderSegments' own rewrites happen.
 */
function auditHandedSegment(segment: object): void {
  const before = handedFields.get(segment);
  if (!before) return;
  const now = segment as Record<string, unknown>;
  for (const key in before) {
    if (Object.is(before[key], now[key])) continue;
    violate(
      "mutated",
      `segment:${String(now.id ?? "?")}`,
      `${key} was written after the tree holding this segment was handed to React; build a new segment object instead`,
    );
  }
  // One report per write: the next build compares with what this one read.
  handedFields.set(segment, { ...now });
}

/** The element renderSegments built for one segment, leaf first. */
export function auditSegmentElement(
  tree: TreeAudit | undefined,
  id: string,
  type: string,
  key: string,
  element: unknown,
  outletTransition: boolean,
  slots: readonly string[],
  segments: readonly object[],
): void {
  if (!tree) return;
  tree.order.push(id);
  tree.keys.set(id, key);
  tree.types.set(id, type);
  // A slot has no key of its own: it stays while its id is in the tree.
  for (const slot of slots) tree.keys.set(slot, slot);
  for (const segment of segments) {
    auditHandedSegment(segment);
    tree.segments.push(segment);
  }
  const chain = wrapperChain(element);
  if (outletTransition) chain.push("outlet:ViewTransition");
  tree.chains.set(id, chain);
}

/**
 * A finished tree. The first is the document's, which React holds from
 * hydration; any later one is held when an emit hands its root to React
 * (auditTreeUpdate).
 */
export function finishTreeAudit(
  tree: TreeAudit | undefined,
  root: unknown,
): void {
  if (!tree) return;
  tree.order.reverse();
  if (heldTree() === undefined) hold(tree);
  else if (root !== null && typeof root === "object") {
    builtTrees.set(root, tree);
  }
}

/**
 * I5: a segment that keeps its React key between two held trees must keep
 * its wrapper chain, or React remounts it (docs/tree-structure.md). The
 * documented remounts are exempt, with everything below them: a key that
 * changes (a param change outside a transition scope), and a segment
 * replaced by another type under the same id (an error or notFound segment
 * takes its route's id, with its own key rule and wrappers). A key whose
 * shape alone changes, `id` against `id-params`, is not one of them: it means
 * `inTransitionScope` differed between the two renders.
 */
function hold(tree: TreeAudit): void {
  const prev = held;
  held = tree;
  // What unmounted under the tree before this one left by something else:
  // an error boundary took the page over, or a layout stopped rendering its
  // outlet. Its next mount is a new one.
  unmounted.clear();
  settledSinceTree.clear();
  for (const segment of tree.segments) {
    handedFields.set(segment, { ...(segment as Record<string, unknown>) });
  }
  tree.segments = [];
  if (INTERNAL_RANGO_DEBUG) {
    trace("tree", {
      segments: tree.order.map((id) => ({
        id,
        type: tree.types.get(id),
        key: tree.keys.get(id),
        chain: tree.chains.get(id),
      })),
    });
  }
  if (!prev) return;
  for (let at = 0; at < tree.order.length; at++) {
    const id = tree.order[at]!;
    const prevKey = prev.keys.get(id);
    if (prevKey === undefined) continue;
    const key = tree.keys.get(id)!;
    const retyped = prev.types.get(id) !== tree.types.get(id);
    if (retyped || prevKey !== key) {
      if (!retyped && (prevKey === id) !== (key === id)) {
        violate(
          "drift",
          `outlet:${id}`,
          `key shape changed from "${prevKey}" to "${key}"`,
        );
      }
      for (let below = at; below < tree.order.length; below++) {
        tree.replaced.add(tree.order[below]!);
      }
      break;
    }
    const before = prev.chains.get(id)!;
    const after = tree.chains.get(id)!;
    const length = Math.max(before.length, after.length);
    for (let i = 0; i < length; i++) {
      if (before[i] === after[i]) continue;
      violate(
        "drift",
        `outlet:${id}`,
        `wrapper chain link ${i} changed from ${before[i] ?? "nothing"} to ${after[i] ?? "nothing"}`,
      );
      break;
    }
  }
}

function keyOf(segmentId: string): string {
  return heldTree()?.keys.get(segmentId) ?? segmentId;
}

// A boundary unmounted while the held tree still holds its segment under the
// same key, until it mounts again or the next tree is held. Not one
// commit's worth: a remounted boundary that suspends mounts its content
// after its fallback.
const unmounted = new Map<string, Set<BoundaryAudit>>();
const remounted: BoundaryAudit[] = [];
// Segments mounted for the first time, or remounted, since the last tree.
const settledSinceTree = new Set<string>();
let flushScheduled = false;

function slotOf(rec: BoundaryAudit): string {
  return `${rec.boundary}|${rec.segmentId}|${rec.key}`;
}

function flushRemounts(): void {
  flushScheduled = false;
  const tree = heldTree();
  const order = tree?.order ?? [];
  const reported = new Set<string>();
  for (const rec of remounted) {
    if (reported.has(rec.segmentId)) continue;
    // A slot (`<parent>.@name`) hangs off its parent segment.
    const parent = rec.segmentId.split(".")[0]!;
    const slot = parent !== rec.segmentId;
    const depth = order.indexOf(parent);
    // Not in the tree React holds: its place is unknown.
    if (depth === -1) continue;
    // Replaced by the documented rules (hold).
    if (tree!.replaced.has(parent)) continue;
    // Below a segment that is new to the page or was itself remounted, a
    // remount is that segment's.
    const end = slot ? depth + 1 : depth;
    let below = false;
    for (let i = 0; i < end && !below; i++) {
      below = settledSinceTree.has(order[i]!);
    }
    if (below) continue;
    reported.add(rec.segmentId);
    violate(
      "remount",
      rec.boundary,
      `unmounted and mounted again under the same key "${rec.key}"`,
    );
  }
  for (const rec of remounted) settledSinceTree.add(rec.segmentId);
  remounted.length = 0;
}

/**
 * I4: a boundary that stays on the page under the same React key is
 * unmounted and mounted again. A different key is the documented remount.
 */
export function auditMount(rec: BoundaryAudit): void {
  getReport();
  rec.key = keyOf(rec.segmentId);
  const gone = unmounted.get(slotOf(rec));
  // StrictMode runs the effects of one instance twice: mount, unmount, mount.
  if (gone?.delete(rec)) return;
  const remount = gone !== undefined && gone.size > 0;
  gone?.clear();
  rec.mountId = (mountCounts.get(rec.boundary) ?? 0) + 1;
  setBounded(mountCounts, rec.boundary, rec.mountId);
  if (INTERNAL_RANGO_DEBUG) {
    trace("mount", {
      boundary: rec.boundary,
      key: rec.key,
      mountId: rec.mountId,
      remount,
    });
  }
  if (remount) remounted.push(rec);
  else settledSinceTree.add(rec.segmentId);
  if (!flushScheduled) {
    flushScheduled = true;
    later(flushRemounts);
  }
}

export function auditUnmount(rec: BoundaryAudit): void {
  if (INTERNAL_RANGO_DEBUG) {
    trace("unmount", {
      boundary: rec.boundary,
      key: rec.key,
      mountId: rec.mountId,
    });
  }
  const slot = slotOf(rec);
  const gone = unmounted.get(slot);
  if (gone) gone.add(rec);
  else unmounted.set(slot, new Set([rec]));
  // Judged once the commit is over: StrictMode mounts this instance again
  // at once, and a segment the held tree dropped or re-keyed is leaving.
  later(() => {
    const now = unmounted.get(slot);
    if (now?.has(rec) && heldTree()?.keys.get(rec.segmentId) !== rec.key) {
      now.delete(rec);
    }
  });
}

const TREE_CAUSES: ReadonlySet<string> = new Set<TreeUpdateCause>([
  "navigation",
  "popstate",
  "stale-revalidation",
  "action",
  "error",
  "hmr",
]);

let treeCause: string | undefined;
let treeCauseTurn = 0;

/**
 * I6: the cause of the tree update the caller emits next, in the same task.
 * It does not outlive the task: an emit after an await names its cause again,
 * or a cause left behind would cover an emitter that names none.
 */
export function auditTreeCause(cause: TreeUpdateCause): void {
  if (!INTERNAL_RANGO_SUSPENSE_AUDIT || typeof window === "undefined") return;
  treeCause = cause;
  const turn = ++treeCauseTurn;
  later(() => {
    if (treeCauseTurn === turn) treeCause = undefined;
  });
}

/**
 * I6: a tree update reached React (the store.onUpdate subscriber in
 * browser/react/NavigationProvider.tsx), with the root it hands React. Only a
 * navigation, a back/forward, its stale revalidation, an action, an error and
 * HMR hand React a tree; anything else updates in place through a store its
 * readers subscribe to, or through a pending promise read with use().
 */
export function auditTreeUpdate(root?: unknown): void {
  if (!INTERNAL_RANGO_SUSPENSE_AUDIT || typeof window === "undefined") return;
  const cause = treeCause;
  treeCause = undefined;
  const r = getReport();
  const name = cause ?? "none";
  r.treeUpdates[name] = (r.treeUpdates[name] ?? 0) + 1;
  if (isThenable(root)) {
    pendingRoot = root;
  } else if (root !== null && typeof root === "object") {
    const tree = builtTrees.get(root);
    if (tree) {
      pendingRoot = undefined;
      hold(tree);
    }
  }
  if (INTERNAL_RANGO_DEBUG) trace("tree-update", { cause: name });
  if (cause === undefined) {
    violate(
      "uncaused",
      "tree",
      "React was handed a tree by an emitter that named no cause; an update that is not a navigation or an action goes through a store or a promise read with use()",
    );
  } else if (!TREE_CAUSES.has(cause)) {
    violate("uncaused", "tree", `"${cause}" is not a cause of a tree update`);
  }
}

/** Forget every tree and mount seen so far. For tests of the audit itself. */
export function forgetSuspenseAudit(): void {
  held = undefined;
  pendingRoot = undefined;
  treeCause = undefined;
  unmounted.clear();
  remounted.length = 0;
  settledSinceTree.clear();
  mountCounts.clear();
  getReport().reset();
}
