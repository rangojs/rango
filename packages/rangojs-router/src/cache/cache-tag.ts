/**
 * Cache Tag API
 *
 * Provides cacheTag() for tagging cached entries at runtime inside "use cache"
 * functions. Tags are scoped via AsyncLocalStorage; calling cacheTag() outside
 * a "use cache" execution throws.
 *
 * The runtime (cache-runtime.ts) wraps "use cache" execution in
 * runWithCacheTagScope(), collects the runtime tags, and merges them with the
 * profile/DSL tags before storing.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  _getRequestContext,
  type RequestContext,
} from "../server/request-context.js";
import {
  getCurrentLoaderBodyId,
  getLoaderBodyTags,
  isInsideLoaderScope,
  type LoaderIdentityRead,
  type LoaderIdentityReadVerb,
} from "../server/context.js";
import type { ExecutionStart } from "./tag-invalidation.js";

const cacheTagStorage = new AsyncLocalStorage<Set<string>>();

/**
 * Each "use cache" tag scope's enclosing scope when it opened (#980). A tag
 * recorded in a scope goes to every scope above it: an intermediate call can
 * return a value holding a nested call still running, whose tags land after
 * the intermediate call reported its own to its caller. Its caller's encode
 * awaits the same promise, so the tags are in before it reads its own.
 */
const scopeParents = new WeakMap<Set<string>, Set<string>>();

/** Add `tag` to `scope` and every scope enclosing it. */
function addToScopes(scope: Set<string> | undefined, tag: string): void {
  for (let s = scope; s; s = scopeParents.get(s)) s.add(tag);
}

/**
 * Call `fn` outside any "use cache" tag scope: detached work a cached body
 * schedules (a stale entry's background refresh) records nothing onto the
 * entry being filled.
 */
export function outsideCacheTagScope<T>(fn: () => T): T {
  return cacheTagStorage.exit(fn);
}

/**
 * Tag owners (#957). A route cache() record replays its segments without
 * running their handlers or re-rendering their server components, so the
 * tags that content recorded must ride on the record, or a HIT (and the PPR
 * capture that replays it) loses them.
 *
 * Every tag records onto its owner: the running loader body
 * (getCurrentLoaderBodyId, server/context.ts), else the segment whose handler
 * or record serialization is running (runInSegmentTagScope). No segment scope
 * opens inside a loader body, so this is innermost-wins. A loader's value
 * reaches a record only through the handler (or loader) that reads it, so
 * ctx.use() links the reader to the loader (linkLoaderTags) whoever started
 * it, and getSegmentTags follows those links. A loader nobody reads
 * server-side (useLoader under loading()) stays off every record.
 *
 * The sets are keyed by the request context a tag records on, so a shell
 * capture's derived context (Object.create(reqCtx)) never reads or feeds the
 * foreground's.
 *
 * All of it runs only for a request that can write a record
 * (RequestContext._recordTagOwners, armed by armRecordTagOwners at match
 * time): elsewhere a handler call takes no scope, closure or allocation.
 */
const segmentOwnerStorage = new AsyncLocalStorage<string>();

/**
 * Arm the record tag owners for `ctx`: its match resolved a cache scope, so
 * it can write a route cache() record (match-api.ts). A capture's or
 * background re-render's derived context inherits the flag.
 */
export function armRecordTagOwners(
  ctx: RequestContext | undefined = _getRequestContext(),
): void {
  if (ctx) ctx._recordTagOwners = true;
}

/** Whether `ctx` records tag owners (see armRecordTagOwners). */
export function recordTagOwnersArmed(
  ctx: RequestContext | undefined = _getRequestContext(),
): boolean {
  return ctx?._recordTagOwners === true;
}

interface RequestTagOwners {
  /** owner key -> tags recorded while it ran */
  tags: Map<string, Set<string>>;
  /** owner key -> loader owner keys whose values it consumed */
  uses: Map<string, Set<string>>;
}
const tagOwnersByRequest = new WeakMap<RequestContext, RequestTagOwners>();

const segmentOwner = (segmentId: string): string => `s:${segmentId}`;
const loaderOwner = (loaderId: string): string => `l:${loaderId}`;

function ownersFor(ctx: RequestContext): RequestTagOwners {
  let owners = tagOwnersByRequest.get(ctx);
  if (!owners) {
    owners = { tags: new Map(), uses: new Map() };
    tagOwnersByRequest.set(ctx, owners);
  }
  return owners;
}

function setFor(map: Map<string, Set<string>>, key: string): Set<string> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

function currentOwner(): string | undefined {
  const loaderId = getCurrentLoaderBodyId();
  return loaderId !== undefined
    ? loaderOwner(loaderId)
    : segmentOwnerStorage.getStore();
}

/**
 * Call `fn(arg)` inside segment `segmentId`'s tag scope: tags recorded while
 * it or its async continuations run (outside a loader body) are owned by that
 * segment. Unarmed, it is a plain call.
 */
export function runInSegmentTagScope<R, A = undefined>(
  segmentId: string,
  fn: (arg: A) => R,
  arg?: A,
): R {
  if (!recordTagOwnersArmed()) return fn(arg as A);
  return segmentOwnerStorage.run(segmentOwner(segmentId), fn, arg as A);
}

/**
 * Record that the current owner reads loader `loaderId`'s value (ctx.use),
 * so the loader's tags follow the reader onto a record. The DSL funnel
 * starting a loader (resolveLoaderData, inside the DSL loader scope but no
 * loader body) is not a reader.
 */
export function linkLoaderTags(
  loaderId: string,
  ctx: RequestContext | undefined = _getRequestContext(),
): void {
  if (!ctx || !recordTagOwnersArmed(ctx)) return;
  const owner = currentOwner();
  if (owner === undefined) return;
  if (owner.startsWith("s:") && isInsideLoaderScope()) return;
  setFor(ownersFor(ctx).uses, owner).add(loaderOwner(loaderId));
}

/**
 * Record `tags` as loader `loaderId`'s own, read outside its body (its
 * cache() config tags, or a loader-cache HIT's stored tags):
 * recordRequestTags with an explicit owner.
 */
export function recordLoaderTags(
  loaderId: string,
  tags: Iterable<string> | undefined,
  ctx: RequestContext | undefined = _getRequestContext(),
): void {
  recordOwnedTags(
    tags,
    ctx,
    recordTagOwnersArmed(ctx) ? loaderOwner(loaderId) : undefined,
  );
}

/**
 * The tags segment `segmentId`'s content recorded in `ctx`: its own, plus
 * those of every loader it consumed, transitively.
 */
export function getSegmentTags(
  ctx: RequestContext,
  segmentId: string,
): ReadonlySet<string> {
  const owners = tagOwnersByRequest.get(ctx);
  const out = new Set<string>();
  if (!owners) return out;
  const seen = new Set<string>();
  const pending = [segmentOwner(segmentId)];
  for (let owner = pending.pop(); owner !== undefined; owner = pending.pop()) {
    if (seen.has(owner)) continue;
    seen.add(owner);
    for (const tag of owners.tags.get(owner) ?? []) out.add(tag);
    for (const used of owners.uses.get(owner) ?? []) pending.push(used);
  }
  return out;
}

/**
 * Record `tags` onto each of `segmentIds` (a route cache() HIT replaying
 * those segments): a record written from the replay, such as a shell
 * capture's doc record (match-middleware/cache-store.ts), then carries them
 * as a fresh render's record would. Unarmed, a no-op.
 */
export function recordSegmentTags(
  segmentIds: readonly string[],
  tags: Iterable<string> | undefined,
  ctx: RequestContext | undefined = _getRequestContext(),
): void {
  if (!tags || !ctx || !recordTagOwnersArmed(ctx)) return;
  for (const id of segmentIds) recordOwnedTags(tags, ctx, segmentOwner(id));
}

/**
 * The owner of the loaders a shell capture bakes (loader-cache.ts bake
 * lane): their data is shell material that no handler reads, so their tags
 * reach the shell through this owner (shell-capture.ts), not a record.
 */
export const SHELL_BAKE_TAG_OWNER: string = "#shell-bake";

/** Link loader `loaderId`'s tags to `ownerId` (see SHELL_BAKE_TAG_OWNER). */
export function linkLoaderTagsTo(
  ownerId: string,
  loaderId: string,
  ctx: RequestContext | undefined = _getRequestContext(),
): void {
  if (!ctx || !recordTagOwnersArmed(ctx)) return;
  setFor(ownersFor(ctx).uses, segmentOwner(ownerId)).add(loaderOwner(loaderId));
}

export function normalizeTag(tag: string): string | null {
  // Trim and return the canonical (trimmed) form, not the raw tag. Both the
  // write path (cacheTag) and the invalidate path (updateTag/revalidateTag)
  // route through here, and matching is exact-string: returning the untrimmed
  // tag made cacheTag(" products ") and updateTag("products") two different
  // logical tags, a silent failure-to-invalidate (stale data served forever).
  const trimmed = tag?.trim();
  return trimmed ? trimmed : null;
}

export function normalizeTags(tags: Iterable<string>): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (normalized !== null) out.push(normalized);
  }
  return out;
}

/**
 * Tag content for later invalidation via updateTag() / revalidateTag().
 *
 * cacheTag() serves two forms depending on what is active when it runs:
 *
 * 1. Inside a "use cache" function — the DEFAULT. The tags go to the current
 *    cache entry; `revalidateTag(tag)` drops that entry. Tags are additive
 *    (multiple calls accumulate), and normalizeTag() is the single chokepoint so
 *    a padded write matches an unpadded invalidate.
 *
 * 2. Render-callable (#648) — no "use cache" scope active, but a request context
 *    is present. The tags record onto the request's DOCUMENT artifact
 *    (ctx._requestTags) instead of throwing. The collection layers already exist:
 *    PPR shell capture unions _requestTags into the shell entry, the document
 *    cache tags the full-page entry with it, and prerender build contexts seed
 *    their own set — so a server component that renders into a shell makes
 *    `revalidateTag("campaign:spring")` evict that shell with ZERO cache()/"use
 *    cache" in its tree. This is PPR's DERIVATIVE invalidation: PPR is
 *    execution-PRESERVING (everything still runs underneath; only document bytes
 *    are shortcut), so its tags ride this existing instrument rather than a
 *    first-class ppr key/tag API. Whatever renders into the shell records here,
 *    at capture or on the route's cache() record the capture replays. A masked
 *    live-lane loader never executes at capture, so its own tags reach a shell
 *    only through a handler that reads it (ctx.use).
 *
 * Inside a route cache() boundary the render-callable form also tags that
 * route's cache() record, which re-records it on every HIT (#957). A loader's
 * tags reach the record only when a handler consumes its value (ctx.use);
 * see runInSegmentTagScope / linkLoaderTags. An empty/whitespace-only tag is
 * dropped in both forms (the render-callable form silently, via normalizeTags in
 * recordRequestTags; the scope form with a dev warning).
 *
 * With neither a scope nor a request context, cacheTag() throws.
 *
 * @example
 * ```typescript
 * // Form 1 — inside "use cache":
 * async function getProduct(ctx) {
 *   "use cache";
 *   cacheTag(`product:${ctx.params.id}`, "products");
 *   return db.getProduct(ctx.params.id);
 * }
 *
 * // Form 2 — render-callable, tags the shell/document from a server component:
 * function CampaignBanner() {
 *   cacheTag("campaign:spring");
 *   return <aside>Spring sale</aside>;
 * }
 * ```
 */
export function cacheTag(...tags: string[]): void {
  const store = cacheTagStorage.getStore();
  if (store) {
    // Form 1: "use cache" scope wins — tag the cache entry (unchanged).
    for (const tag of tags) {
      const normalized = normalizeTag(tag);
      if (normalized === null) {
        if (process.env.NODE_ENV !== "production") {
          console.warn(`[cacheTag] Ignoring empty or whitespace-only tag.`);
        }
        continue;
      }
      addToScopes(store, normalized);
    }
    return;
  }

  const reqCtx = _getRequestContext();
  if (reqCtx?._requestTags) {
    // Form 2: render-callable — tag the request's document artifact. See the
    // JSDoc above for the composition doctrine and the baked/hole invariant.
    recordRequestTags(tags, reqCtx);
    return;
  }

  throw new Error(
    'cacheTag() must be called inside a "use cache" function or during a request render.',
  );
}

export function recordRequestTags(
  tags: Iterable<string> | undefined,
  ctx: RequestContext | undefined = _getRequestContext(),
): void {
  recordOwnedTags(
    tags,
    ctx,
    recordTagOwnersArmed(ctx) ? currentOwner() : undefined,
  );
}

/**
 * Recorded-tag sets (#964). A loader with its own cache() skips its body on a
 * HIT, so its entry stores what its execution recorded, including the tags of
 * every loader value it read, whoever ran that loader.
 *
 * Each loader execution records into its own set, held on its body scope
 * (runInsideLoaderBodyScope); a loader-cache MISS opens one around its
 * execution and value encodes (captureRecordedTags). The innermost wins. A
 * read of a loader's value links the reader's set to the value's
 * (readValueTags), and the entry write flattens the links
 * (flattenRecordedTags) after its value settled.
 *
 * The per-execution sets and read links run only for a request that resolves
 * a loader-cache binding (armLoaderTagSets); elsewhere a loader execution
 * allocates no set and a read links nothing.
 *
 * The same sets carry the execution's request-identity reads (#972,
 * recordLoaderIdentityRead in server/context.ts): an entry with no declared
 * key refuses an execution whose links reach one (recordedIdentityRead).
 */
interface TagCapture {
  into: Set<string>;
  /** The loader body set active when the capture opened. */
  outer: Set<string> | undefined;
}
// On globalThis like the loader scopes (server/context.ts): the identity-read
// recorder is installed there too, so a second evaluated copy of this module
// (a duplicated package, a dev re-evaluation) must share the capture scope and
// the recorded reads, or its recorder writes where no fill looks.
const recordedTagCapture: AsyncLocalStorage<TagCapture> = ((globalThis as any)[
  Symbol.for("rangojs-router:recorded-tag-capture")
] ??= new AsyncLocalStorage<TagCapture>());
const tagLinks = new WeakMap<Set<string>, Set<Set<string>>>();
const loaderValueTags = new WeakMap<object, Set<string>>();
const identityReads: WeakMap<Set<string>, LoaderIdentityRead> = ((
  globalThis as any
)[Symbol.for("rangojs-router:identity-reads")] ??= new WeakMap());

/**
 * Arm the per-execution loader tag sets for `ctx`: its match resolved a
 * loader bound with its own cache() (match-api.ts, bindsLoaderCache), or such
 * a binding started (loader-cache.ts). A loader-cache MISS captures its own
 * execution and encodes either way.
 */
export function armLoaderTagSets(
  ctx: RequestContext | undefined = _getRequestContext(),
): void {
  if (ctx) ctx._recordLoaderTags = true;
}

/** Whether `ctx` records per-execution loader tag sets (armLoaderTagSets). */
export function loaderTagSetsArmed(ctx: RequestContext | undefined): boolean {
  return ctx?._recordLoaderTags === true;
}

function activeTagSet(): Set<string> | undefined {
  const capture = recordedTagCapture.getStore();
  const body = getLoaderBodyTags();
  if (capture && capture.outer === body) return capture.into;
  return body ?? capture?.into;
}

/**
 * Call `fn`, adding every tag recorded in its async chain
 * (recordRequestTags, recordLoaderTags) to `into`, until a loader body
 * started inside it takes over with its own set.
 */
export function captureRecordedTags<T>(into: Set<string>, fn: () => T): T {
  return recordedTagCapture.run({ into, outer: getLoaderBodyTags() }, fn);
}

/** `into` also answers for every tag `from` records. */
export function linkRecordedTags(into: Set<string>, from: Set<string>): void {
  if (into === from) return;
  let links = tagLinks.get(into);
  if (!links) tagLinks.set(into, (links = new Set()));
  links.add(from);
}

/** Mark a loader's value promise as carrying `tags` (see readValueTags). */
export function tagLoaderValue(value: object, tags: Set<string>): void {
  loaderValueTags.set(value, tags);
}

/** A loader value's tags also answer for `tags` (tagLoaderValue). */
export function linkValueTags(value: object, tags: Set<string>): void {
  const own = loaderValueTags.get(value);
  if (own) linkRecordedTags(own, tags);
}

/** The current execution reads a loader's value: it takes on its tags. */
export function readValueTags(value: object): void {
  const tags = loaderValueTags.get(value);
  if (!tags) return;
  const into = activeTagSet();
  if (into) linkRecordedTags(into, tags);
}

// recordLoaderIdentityRead (server/context.ts) calls this through the shared
// key, not an import: a test mocking context.ts would break module init. First
// read per execution: the fill's error names it.
(globalThis as Record<symbol, unknown>)[
  Symbol.for("rangojs-router:identity-read-recorder")
] = (surface: string, verb: LoaderIdentityReadVerb): void => {
  const set = activeTagSet();
  if (set === undefined || identityReads.has(set)) return;
  identityReads.set(set, { surface, verb, bodyId: getCurrentLoaderBodyId() });
};

/**
 * A loader-cache HIT restores the read its entry's MISS recorded onto the
 * value's set, so an unkeyed reader of the value refuses it as it would on
 * the MISS (loader-cache.ts identity mark).
 */
export function markIdentityRead(
  set: Set<string>,
  read: LoaderIdentityRead,
): void {
  if (!identityReads.has(set)) identityReads.set(set, read);
}

/**
 * The identity read `root`'s execution recorded, or one a set it links to
 * recorded, nearest first (breadth-first, so the execution's own read wins).
 */
export function recordedIdentityRead(
  root: Set<string>,
): LoaderIdentityRead | undefined {
  const seen = new Set<Set<string>>();
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const set = queue[i]!;
    if (seen.has(set)) continue;
    seen.add(set);
    const read = identityReads.get(set);
    if (read) return read;
    for (const linked of tagLinks.get(set) ?? []) queue.push(linked);
  }
  return undefined;
}

/** `root` and every set it links to, transitively. */
function linkedSets(root: Set<string>): Set<Set<string>> {
  const seen = new Set<Set<string>>();
  const pending = [root];
  for (let set = pending.pop(); set !== undefined; set = pending.pop()) {
    if (seen.has(set)) continue;
    seen.add(set);
    for (const linked of tagLinks.get(set) ?? []) pending.push(linked);
  }
  return seen;
}

/** `root`'s tags plus those of every set it links to, transitively. */
export function flattenRecordedTags(root: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const set of linkedSets(root)) {
    for (const tag of set) out.add(tag);
  }
  return out;
}

/**
 * Where each execution that records into a set started (#977): a loader
 * execution (createLoaderExecutor), a loader-cache MISS or refresh, a
 * loader-cache binding's value.
 */
const tagSetStarts = new WeakMap<Set<string>, ExecutionStart>();

/** Record where the execution recording into `set` started. */
export function markTagSetStart(set: Set<string>, start: ExecutionStart): void {
  tagSetStarts.set(set, start);
}

/**
 * The earliest start among `root` and every set it links to: a value built
 * from another execution's value is as old as the oldest of them. A
 * loader-cache write gates on it (loader-cache.ts), because the loader value
 * it stores can be a run a reader started before the binding executed, and
 * the values that run read can be older still.
 */
export function earliestRecordedStart(
  root: Set<string>,
): ExecutionStart | undefined {
  let earliest: ExecutionStart | undefined;
  for (const set of linkedSets(root)) {
    const start = tagSetStarts.get(set);
    if (!start) continue;
    earliest = earliest
      ? {
          seq: Math.min(earliest.seq, start.seq),
          at: Math.min(earliest.at, start.at),
        }
      : start;
  }
  return earliest;
}

/**
 * recordRequestTags, also recording onto `owner`'s set (#957), the active
 * loader tag set (#964), and the enclosing "use cache" execution's tag
 * scope (#980).
 *
 * The last one is how a nested "use cache" call's tags reach the entry that
 * bakes its value: the inner wrapper records its tags (a miss's, a hit's
 * stored ones, a joined execution's) after its own scope closed, so the
 * scope current then is the caller's. Without it an outer entry kept the
 * inner value past updateTag() of an inner tag, and the same-request gate
 * (tag-invalidation.ts invalidatedSince) did not see the outer execution
 * as tagged by it.
 */
function recordOwnedTags(
  tags: Iterable<string> | undefined,
  ctx: RequestContext | undefined,
  owner: string | undefined,
): void {
  if (!tags || !ctx?._requestTags) return;
  const set = ctx._requestTags;
  const captured = activeTagSet();
  const enclosing = cacheTagStorage.getStore();
  let owned: Set<string> | undefined;
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (normalized === null) continue;
    set.add(normalized);
    captured?.add(normalized);
    addToScopes(enclosing, normalized);
    if (owner !== undefined) {
      owned ??= setFor(ownersFor(ctx).tags, owner);
      owned.add(normalized);
    }
  }
}

/**
 * Run a function within a cache tag scope. Any cacheTag() calls inside `fn`,
 * and the tags a nested "use cache" call records (recordOwnedTags, #980),
 * accumulate into the returned Set and every scope enclosing it
 * (scopeParents).
 *
 * The returned Set is the LIVE reference - the caller must await `result`
 * before reading `tags`, because an async cached function may call cacheTag()
 * after an await boundary. Pass `tagSet` to re-enter an execution's scope
 * (its result's Flight encode, #980); it keeps the parent it opened under.
 *
 * @internal Used by cache-runtime.ts to wrap "use cache" execution.
 */
export function runWithCacheTagScope<T>(
  fn: () => T,
  tagSet?: Set<string>,
): {
  result: T;
  tags: Set<string>;
} {
  let scope = tagSet;
  if (!scope) {
    scope = new Set<string>();
    const parent = cacheTagStorage.getStore();
    if (parent) scopeParents.set(scope, parent);
  }
  const result = cacheTagStorage.run(scope, fn);
  return { result, tags: scope };
}
