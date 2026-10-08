/**
 * Dev-only audit of what the router hands its Suspense boundaries and of the
 * tree those boundaries sit in (docs/internal/suspense-contract.md). Every
 * call site is behind `process.env.NODE_ENV !== "production"`, so a build
 * carries none of this module (tools/check-bundle-guards.mjs).
 *
 * React warns about none of this: its uncached-promise warning covers a
 * promise created during render (a different thenable on a replay of one
 * render attempt), never a boundary handed a different promise by a later
 * render.
 *
 * No React import: segment-system.tsx is evaluated outside the browser too.
 * The hooks are in suspense-audit-react.tsx.
 */
import { INTERNAL_RANGO_DEBUG } from "./internal-debug.js";

export type SuspenseAuditKind =
  | "swap"
  | "untracked"
  | "idle-fallback"
  | "resuspended"
  | "remount"
  | "drift"
  | "uncaused";

/** What may hand React a tree (I6). */
export type TreeUpdateCause =
  | "navigation"
  | "popstate"
  | "stale-revalidation"
  | "action"
  | "error"
  | "hmr";

export interface SuspenseAuditEvent {
  /** I1 swap, I2 untracked, I3 idle-fallback and resuspended, I4 remount, I5 drift, I6 uncaused. */
  kind: SuspenseAuditKind;
  /** `content:<segment id>`, `loaders:<outlet key>`, `outlet:<segment id>`, `read:<loader id>`. */
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
  /** Not a violation: tree updates React was handed, by cause ("none" without one). */
  treeUpdates: Record<string, number>;
  /**
   * Not a violation: the distinct thenables each boundary or read was handed.
   * One per value it waited for; two for one navigation is a gate replaced
   * by the real promise.
   */
  handed: Record<string, number>;
  /**
   * Not a violation: fallbacks shown over content on screen while what the
   * boundary waits for was pending. An urgent commit does that by design.
   */
  shownWhilePending: number;
  /** Mounts per boundary since the document loaded. */
  mounts: Record<string, number>;
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
const MAX_EVENTS = 50;

type Thenable = { then: unknown; status?: string; value?: unknown };

function isThenable(value: unknown): value is Thenable {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

// A Flight chunk extends Promise.prototype with its own `then` and always
// carries a status. Its `then` initializes a resolved chunk, so the audit
// never calls it.
function isNative(value: Thenable): boolean {
  return value.then === Promise.prototype.then;
}

// A native promise React has not read carries no status: the audit observes
// its settlement itself.
const settled = new WeakMap<object, unknown>();
const observed = new WeakSet<object>();

function observe(value: unknown): void {
  if (!isThenable(value) || value.status !== undefined) return;
  if (!isNative(value) || observed.has(value)) return;
  observed.add(value);
  (value as unknown as Promise<unknown>).then(
    (result) => settled.set(value, result),
    () => settled.set(value, undefined),
  );
}

function isPending(value: unknown): boolean {
  if (!isThenable(value)) return false;
  const status = value.status;
  if (status === undefined) return !settled.has(value);
  return status === "pending" || status === "blocked" || status === "halted";
}

function anyPending(streams: Record<string, unknown> | undefined): boolean {
  if (!streams) return false;
  for (const id in streams) if (isPending(streams[id])) return true;
  return false;
}

// What a settled thenable holds, where the audit can know it.
function settledValue(value: unknown): unknown {
  if (!isThenable(value)) return value;
  if (value.status === "fulfilled") return value.value;
  return settled.get(value);
}

const LAZY = Symbol.for("react.lazy");
const MAX_SCAN = 400;

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
      for (const child of node) stack.push(child);
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
    stack.push(element.type);
    for (const name in element.props) stack.push(element.props[name]);
  }
  return false;
}

function describe(value: unknown): string {
  if (isThenable(value)) {
    const status = value.status ?? (settled.has(value) ? "settled" : "unread");
    return `${isNative(value) ? "promise" : "Flight chunk"} (${status})`;
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
    treeUpdates: {},
    handed: {},
    shownWhilePending: 0,
    mounts: {},
    events: [],
    reset() {
      created.swaps = 0;
      created.untracked = 0;
      created.idleFallbacks = 0;
      created.resuspended = 0;
      created.remounts = 0;
      created.drifts = 0;
      created.uncaused = 0;
      created.treeUpdates = {};
      created.handed = {};
      handedSeen = new Map();
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
  | "uncaused";

const RULES: Record<SuspenseAuditKind, [invariant: string, counter: Counter]> =
  {
    swap: ["I1", "swaps"],
    untracked: ["I2", "untracked"],
    "idle-fallback": ["I3", "idleFallbacks"],
    resuspended: ["I3", "resuspended"],
    remount: ["I4", "remounts"],
    drift: ["I5", "drifts"],
    uncaused: ["I6", "uncaused"],
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

// Every hand-over, mount and fallback, for a debug run to read back.
function trace(type: string, data: Record<string, unknown>): void {
  if (!INTERNAL_RANGO_DEBUG) return;
  console.log(
    `${PREFIX}[trace] ${JSON.stringify({ type, ...data, url: href(), at: Math.round(performance.now()) })}`,
  );
}

let streamProbe: (() => boolean) | undefined;

/** How the audit learns that a payload is still streaming (the event controller). */
export function setSuspenseAuditStreamProbe(probe: () => boolean): void {
  streamProbe = probe;
}

function streamOpen(): boolean {
  if (typeof document !== "undefined" && document.readyState === "loading") {
    return true;
  }
  return streamProbe?.() === true;
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

// The settlement of a promise first seen in this task is observed a
// microtask after it.
function afterMicrotasks(run: () => void): void {
  queueMicrotask(() => queueMicrotask(run));
}

// By boundary, not by record: a reader that suspends while mounting keeps
// no record between its attempts.
let handedSeen = new Map<string, WeakSet<object>>();

function countHanded(boundary: string, value: unknown): void {
  if (!isThenable(value)) return;
  let seen = handedSeen.get(boundary);
  if (!seen) handedSeen.set(boundary, (seen = new WeakSet()));
  if (seen.has(value)) return;
  seen.add(value);
  const r = getReport();
  r.handed[boundary] = (r.handed[boundary] ?? 0) + 1;
}

/**
 * Render phase: the value this render hands the boundary.
 *
 * I1: a boundary on screen was handed a thenable that is still pending, and
 * is handed another one that is not already settled, for the same URL. React
 * starts waiting again. A settled replacement is read at once, and another
 * URL is another navigation: both are exempt.
 * I2: a boundary whose content has been on screen is handed a settled native
 * promise React has not read. A render that cannot wait suspends on it and
 * commits the fallback over the content, which React keeps up for 300 ms.
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
  const untracked =
    isThenable(value) && isNative(value) && value.status === undefined;
  const wasSettled = untracked && settled.has(value);
  observe(value);
  trace("handover", {
    boundary: rec.boundary,
    mountId: rec.mountId,
    revealed: rec.revealed,
    handed: describe(value),
    previous: hadPrevious ? describe(previous) : "none",
    previousPending: hadPrevious && isPending(previous),
    sameUrl,
  });
  if (
    rec.mountId > 0 &&
    hadPrevious &&
    sameUrl &&
    isPending(previous) &&
    isThenable(value) &&
    isPending(value) &&
    !wasSettled
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
    if (untracked) afterMicrotasks(swapped);
    else swapped();
  }
  if (rec.revealed && untracked) {
    const unread = (): void => {
      if (!settled.has(value as object)) return;
      violate(
        "untracked",
        rec.boundary,
        "content on screen was handed a settled promise React has not read; hand the value itself",
      );
    };
    if (wasSettled) unread();
    else afterMicrotasks(unread);
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
  if (!rec.revealed) {
    trace("reveal", { boundary: rec.boundary, mountId: rec.mountId });
  }
  rec.revealed = true;
}

/**
 * I3: the boundary's fallback is on screen with nothing to wait for: nothing
 * the router handed the boundary is pending, no payload is streaming and no
 * client reference is loading. `idle-fallback` on a boundary new to the page,
 * `resuspended` when the fallback replaced content that had been on screen.
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
      const waiting = isPending(handed) || anyPending(rec.streams);
      const streaming = streamOpen();
      const loading =
        hasBlockedReference(settledValue(handed)) ||
        hasBlockedReference(rec.nodes);
      trace("fallback", {
        boundary: rec.boundary,
        mountId: rec.mountId,
        revealed,
        waiting,
        streaming,
        loading,
        handed: describe(handed),
      });
      if (waiting || streaming || loading) {
        if (revealed) getReport().shownWhilePending += 1;
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
    queueMicrotask(() => {
      rec.fallbackGone = false;
    });
    trace("fallback-gone", {
      boundary: rec.boundary,
      mountId: rec.mountId,
      ms: Math.round(performance.now() - shownAt),
    });
  };
}

/** One renderSegments call, collected while it builds. */
export interface TreeAudit {
  /** Segment ids, root first. */
  order: string[];
  keys: Map<string, string>;
  types: Map<string, string>;
  chains: Map<string, string[]>;
  /** Segments this tree remounts by the documented rules. */
  replaced: Set<string>;
}

let lastTree: TreeAudit | undefined;

// The router's wrapper components, by function name. The boundary components
// are their dev variants here (route-content-wrapper.tsx, outlet-provider.tsx):
// a link is named after the export.
const WRAPPERS = new Map([
  ["MountContextProvider", "MountContextProvider"],
  ["AuditedLoaderBoundary", "LoaderBoundary"],
  ["AuditedOutletProvider", "OutletProvider"],
  ["StreamedLoaderErrorBoundary", "StreamedLoaderErrorBoundary"],
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
  if (typeof window === "undefined") return undefined;
  return {
    order: [],
    keys: new Map(),
    types: new Map(),
    chains: new Map(),
    replaced: new Set(),
  };
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
): void {
  if (!tree) return;
  tree.order.unshift(id);
  tree.keys.set(id, key);
  tree.types.set(id, type);
  // A slot has no key of its own: it stays while its id is in the tree.
  for (const slot of slots) tree.keys.set(slot, slot);
  const chain = wrapperChain(element);
  if (outletTransition) chain.push("outlet:ViewTransition");
  tree.chains.set(id, chain);
}

/**
 * I5: a segment that keeps its React key between two trees must keep its
 * wrapper chain, or React remounts it (docs/tree-structure.md). The
 * documented remounts are exempt, with everything below them: a key that
 * changes (a param change outside a transition scope), and a segment
 * replaced by another type under the same id (an error or notFound segment
 * takes its route's id, with its own key rule and wrappers). A key whose
 * shape alone changes, `id` against `id-params`, is not one of them: it means
 * `inTransitionScope` differed between the two renders.
 */
export function finishTreeAudit(tree: TreeAudit | undefined): void {
  if (!tree) return;
  const prev = lastTree;
  lastTree = tree;
  // What this tree drops or re-keys is leaving: its next mount is a new one.
  for (const [slot, gone] of unmounted) {
    const [, id, key] = slot.split("|");
    if (tree.keys.get(id) !== key) unmounted.delete(slot);
    else if (gone.size === 0) unmounted.delete(slot);
  }
  settledSinceTree.clear();
  trace("tree", {
    segments: tree.order.map((id) => ({
      id,
      type: tree.types.get(id),
      key: tree.keys.get(id),
      chain: tree.chains.get(id),
    })),
  });
  if (!prev) return;
  for (let at = 0; at < tree.order.length; at++) {
    const id = tree.order[at];
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
      for (const below of tree.order.slice(at)) tree.replaced.add(below);
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
  return lastTree?.keys.get(segmentId) ?? segmentId;
}

// A boundary unmounted while the last tree still holds its segment under the
// same key, until it mounts again or a tree drops the segment. Not one
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

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    const order = lastTree?.order ?? [];
    const reported = new Set<string>();
    for (const rec of remounted) {
      if (reported.has(rec.segmentId)) continue;
      // A slot (`<parent>.@name`) hangs off its parent segment.
      const parent = rec.segmentId.split(".")[0];
      const slot = parent !== rec.segmentId;
      const depth = order.indexOf(parent);
      // Not in the last tree renderSegments built: its place is unknown.
      if (depth === -1) continue;
      // Replaced by the documented rules (finishTreeAudit).
      if (lastTree!.replaced.has(parent)) continue;
      const above = order.slice(0, slot ? depth + 1 : depth);
      // Below a segment that is new to the page or was itself remounted, a
      // remount is that segment's.
      if (above.some((id) => settledSinceTree.has(id))) continue;
      reported.add(rec.segmentId);
      violate(
        "remount",
        rec.boundary,
        `unmounted and mounted again under the same key "${rec.key}"`,
      );
    }
    for (const rec of remounted) settledSinceTree.add(rec.segmentId);
    remounted.length = 0;
  });
}

/**
 * I4: a boundary that stays on the page under the same React key is
 * unmounted and mounted again. A different key is the documented remount.
 */
export function auditMount(rec: BoundaryAudit): void {
  const r = getReport();
  rec.key = keyOf(rec.segmentId);
  const gone = unmounted.get(slotOf(rec));
  // StrictMode runs the effects of one instance twice: mount, unmount, mount.
  if (gone?.delete(rec)) return;
  const remount = gone !== undefined && gone.size > 0;
  gone?.clear();
  rec.mountId = (r.mounts[rec.boundary] ?? 0) + 1;
  r.mounts[rec.boundary] = rec.mountId;
  trace("mount", {
    boundary: rec.boundary,
    key: rec.key,
    mountId: rec.mountId,
    remount,
  });
  if (remount) remounted.push(rec);
  else settledSinceTree.add(rec.segmentId);
  scheduleFlush();
}

export function auditUnmount(rec: BoundaryAudit): void {
  trace("unmount", {
    boundary: rec.boundary,
    key: rec.key,
    mountId: rec.mountId,
  });
  const slot = slotOf(rec);
  const gone = unmounted.get(slot);
  if (gone) gone.add(rec);
  else unmounted.set(slot, new Set([rec]));
  // Judged once the commit is over: StrictMode mounts this instance again
  // at once, and a segment the last tree dropped or re-keyed is leaving.
  queueMicrotask(() => {
    const now = unmounted.get(slot);
    if (now?.has(rec) && lastTree?.keys.get(rec.segmentId) !== rec.key) {
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
  if (typeof window === "undefined") return;
  treeCause = cause;
  const turn = ++treeCauseTurn;
  queueMicrotask(() => {
    if (treeCauseTurn === turn) treeCause = undefined;
  });
}

/**
 * I6: a tree update reached React (the store.onUpdate subscriber in
 * browser/react/NavigationProvider.tsx). Only a navigation, a back/forward,
 * its stale revalidation, an action, an error and HMR hand React a tree;
 * anything else updates in place through a store its readers subscribe to,
 * or through a pending promise read with use().
 */
export function auditTreeUpdate(): void {
  if (typeof window === "undefined") return;
  const cause = treeCause;
  treeCause = undefined;
  const r = getReport();
  const name = cause ?? "none";
  r.treeUpdates[name] = (r.treeUpdates[name] ?? 0) + 1;
  trace("tree-update", { cause: name });
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
  lastTree = undefined;
  treeCause = undefined;
  handedSeen = new Map();
  unmounted.clear();
  remounted.length = 0;
  settledSinceTree.clear();
  const r = getReport();
  r.reset();
  r.mounts = {};
}
