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
  isInsideLoaderScope,
} from "../server/context.js";

const cacheTagStorage = new AsyncLocalStorage<Set<string>>();

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
 * Record `tags` as loader `loaderId`'s own (its cache() config tags, read
 * outside its body): recordRequestTags with an explicit owner.
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
      store.add(normalized);
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

/** recordRequestTags, also recording onto `owner`'s set (#957). */
function recordOwnedTags(
  tags: Iterable<string> | undefined,
  ctx: RequestContext | undefined,
  owner: string | undefined,
): void {
  if (!tags || !ctx?._requestTags) return;
  const set = ctx._requestTags;
  let owned: Set<string> | undefined;
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (normalized === null) continue;
    set.add(normalized);
    if (owner !== undefined) {
      owned ??= setFor(ownersFor(ctx).tags, owner);
      owned.add(normalized);
    }
  }
}

/**
 * Run a function within a cache tag scope. Any cacheTag() calls inside `fn`
 * accumulate into the returned Set.
 *
 * The returned Set is the LIVE reference - the caller must await `result`
 * before reading `tags`, because an async cached function may call cacheTag()
 * after an await boundary.
 *
 * @internal Used by cache-runtime.ts to wrap "use cache" execution.
 */
export function runWithCacheTagScope<T>(fn: () => T): {
  result: T;
  tags: Set<string>;
} {
  const tagSet = new Set<string>();
  const result = cacheTagStorage.run(tagSet, fn);
  return { result, tags: tagSet };
}
