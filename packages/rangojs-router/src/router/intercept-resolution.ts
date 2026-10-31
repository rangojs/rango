/**
 * Intercept Resolution
 *
 * Extracted from createRouter closure. Contains intercept detection and resolution
 * functions for soft navigation (modals).
 */

import type { ReactNode } from "react";
import type {
  EntryData,
  InterceptEntry,
  InterceptSelectorContext,
} from "../server/context";
import type { InternalHandlerContext, ResolvedSegment } from "../types";
import {
  handleHandlerResult,
  warnOnStreamedResponse,
  buildLoaderErrorContext,
} from "./segment-resolution.js";
import { catchSegmentError } from "./segment-resolution/helpers.js";
import { trackStreamedHandler } from "./segment-resolution/streamed-handler-boundary.js";
import { findInOrphans } from "./error-handling.js";
import {
  deliverStartedLoaders,
  resolveOwnerLoaders,
} from "./segment-resolution/revalidation.js";
import { fillSends } from "./segment-resolution/prefetch-deferral.js";
import type { ResolutionPass } from "./segment-resolution/resolution-pass.js";
import { getRouterContext, type InterceptResult } from "./router-context.js";
import { runInSegmentTagScope } from "../cache/cache-tag.js";
import {
  RangoContext,
  latchPprHeaderScopeForEntries,
} from "../server/context.js";
import { _getRequestContext } from "../server/request-context.js";

/**
 * Header-guard latch for the intercept funnels (issue #713). ppr and
 * intercepts do not compose on the shell path — shells are captured/served
 * only for document requests and withInterceptResolution skips intercepts on
 * full matches — so this is defense in depth: a partial nav CAN render an
 * intercept over a ppr-declared target route, in its own store scope where
 * the main funnel's latch does not apply. Latch by declaration, off the
 * target route's manifest entry (same leaf input as the segment funnels).
 */
function latchPprHeaderScopeForInterceptTarget(
  interceptEntry: InterceptEntry,
): void {
  const targetEntry = RangoContext.getStore()?.manifest.get(
    interceptEntry.routeName,
  );
  if (targetEntry) {
    latchPprHeaderScopeForEntries([targetEntry], interceptEntry.routeName);
  }
}

/**
 * Check if an intercept's when conditions are satisfied.
 * All when() functions must return true for the intercept to activate.
 * If no when() conditions are defined, the intercept always activates.
 * A selector that throws yields the conservative default, no intercept (the
 * full page renders), and is logged; it never fails the request.
 */
export function evaluateInterceptWhen(
  intercept: InterceptEntry,
  selectorContext: InterceptSelectorContext | null,
): boolean {
  if (!intercept.when || intercept.when.length === 0) {
    return true;
  }

  if (!selectorContext) {
    return false;
  }

  try {
    return intercept.when.every((fn) => fn(selectorContext));
  } catch (error) {
    console.error(
      `[rango] intercept({ when }) for route "${selectorContext.to.routeName ?? intercept.routeName}" (${intercept.slotName}) threw; rendering the full page without the intercept.`,
      error,
    );
    return false;
  }
}

/**
 * Walk the intercepts declared along `fromEntry`'s chain in selection order,
 * an entry's own and then its orphans' (nested ones included) in render
 * order, from `fromEntry` up, until `pick` returns a value. Tolerates partial
 * entries (unit-test mocks omit the arrays); real registration always
 * populates layout/intercept.
 */
function findOnChain<T>(
  fromEntry: EntryData | null,
  pick: (intercept: InterceptEntry, entry: EntryData) => T | undefined,
): T | undefined {
  const visit = (entry: EntryData): T | undefined => {
    for (const intercept of entry.intercept ?? []) {
      const found = pick(intercept, entry);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  let current: EntryData | null = fromEntry;
  let prev: EntryData | null = null;
  while (current) {
    const found = visit(current) ?? findInOrphans(current, visit, prev);
    if (found !== undefined) return found;
    prev = current;
    current = current.parent;
  }
  return undefined;
}

/**
 * Collect every intercept TARGET route name reachable from an origin entry —
 * the same chain walk findInterceptForRoute() performs when this location is
 * the navigation origin. Shipped in payload metadata so the browser-local
 * clientUrls matcher can DECLINE its optimistic presentation for targets an
 * intercept would claim (the committed result keeps the origin page + modal,
 * so destination loading would flash and revert). Deliberately includes
 * `when`-conditional intercepts: selectors need the live navigation context,
 * so the browser stays conservative — worst case a non-intercepted navigation
 * loses its optimistic loading, never the reverse.
 */
export function collectInterceptTargetNames(
  fromEntry: EntryData | null,
): string[] {
  const names = new Set<string>();
  findOnChain(fromEntry, (intercept) => {
    names.add(intercept.routeName);
    return undefined;
  });
  return [...names];
}

/**
 * The intercept for the target route, with the entry that declares it.
 * `targetRouteKeys` are the names it may be declared for, in precedence
 * order: the route's own name, then its local name inside include()
 * (match-api.ts). A navigation, or an action with no `held`, takes the first
 * along the chain from `fromEntry` up under the first name that has one: on a
 * navigation, the first whose when() passes; on an action, the first, when()
 * not evaluated.
 *
 * An action given `held` (the request's segment ids) re-renders the intercept
 * on screen: one whose slot id the client holds, null when it holds none. Its
 * candidates are collected under every name in one walk, the route's own
 * name's first: a held id under the own name (a parallel() default of the
 * slot's name) must not win before the local name is looked at. One held:
 * that one, when() not evaluated, so an open intercept stays open when its
 * when() would now reject. Several held (intercepts on one entry that fill one
 * slot share its id, as does a parallel() slot of that name): the ones whose
 * slot has no parallel() default on their entry, if any (a default holds its
 * slot id whether or not an intercept is open there). One left: that one,
 * when() not evaluated. Else the first whose when() passes against the
 * action's intercept source, else the first.
 */
export function findInterceptForRoute(
  targetRouteKeys: string | readonly string[],
  fromEntry: EntryData | null,
  selectorContext: InterceptSelectorContext | null = null,
  isAction: boolean = false,
  held?: ReadonlySet<string>,
): InterceptResult | null {
  const names =
    typeof targetRouteKeys === "string" ? [targetRouteKeys] : targetRouteKeys;
  if (!isAction || !held) {
    for (const name of names) {
      const found = findOnChain(fromEntry, (intercept, entry) =>
        intercept.routeName === name &&
        (isAction || evaluateInterceptWhen(intercept, selectorContext))
          ? { intercept, entry }
          : undefined,
      );
      if (found) return found;
    }
    return null;
  }
  const byName: InterceptResult[][] = names.map(() => []);
  findOnChain(fromEntry, (intercept, entry) => {
    const rank = names.indexOf(intercept.routeName);
    if (rank !== -1 && held.has(interceptSlotId(entry, intercept))) {
      byName[rank]!.push({ intercept, entry });
    }
    return undefined;
  });
  const open = byName.flat();
  if (open.length < 2) return open[0] ?? null;
  // A parallel() default of the slot's name holds its slot id whichever
  // intercept is open, so a candidate that has one proves nothing about what
  // is on screen: among several, the ones without a default are the open ones.
  const unshadowed = open.filter(
    (c) => !c.entry.parallel?.[c.intercept.slotName],
  );
  const pool = unshadowed.length > 0 ? unshadowed : open;
  if (pool.length === 1) return pool[0]!;
  return (
    pool.find((c) => evaluateInterceptWhen(c.intercept, selectorContext)) ??
    pool[0]!
  );
}

/**
 * An intercept handler's throw or notFound() renders the declaring entry's
 * boundary as the slot component (catchSegmentError, as for route handlers on
 * partial navigations: 500/404 status, onError "handler" naming the slot).
 * Responses rethrow. The background re-render (`background`) reports the
 * error the same way and then rethrows it, so a failed re-render aborts its
 * cache write instead of storing the fallback.
 */
function renderInterceptHandlerError<TEnv>(
  pass: ResolutionPass<TEnv>,
  error: unknown,
  parentEntry: EntryData,
  slotSegmentId: string,
  background: boolean | undefined,
): ReactNode {
  if (error instanceof Response) throw error;
  // A background re-render's waitUntil task may run outside the router
  // context, as the segment walk's report allows.
  let telemetry;
  try {
    telemetry = getRouterContext()?.telemetry;
  } catch {}
  const { component } = catchSegmentError(
    error,
    parentEntry,
    pass.params,
    pass.deps,
    {
      ...buildLoaderErrorContext(pass.context),
      isPartial: true,
      telemetry,
    },
    pass.context.pathname,
    { id: slotSegmentId, type: "parallel" },
  );
  if (background) throw error;
  return component;
}

/** The segment id of `intercept`'s slot on `parentEntry`. */
export function interceptSlotId(
  parentEntry: EntryData,
  intercept: InterceptEntry,
): string {
  return `${parentEntry.shortCode}.${intercept.slotName}`;
}

/**
 * The intercept a match selected (findInterceptForRoute), as its cache()
 * record names it (CacheScope): the slot id, then `~` and its position among
 * the intercepts its entry declares for the same slot and target route. Two
 * such intercepts share the slot id, and the position tells them apart; one
 * for another slot or route does not renumber it. `~` is unreserved in a
 * URL, so a store that maps the key onto one unencoded keeps the whole key.
 * Undefined when the match selected none.
 */
export function interceptRecordKey(
  selected: { intercept: InterceptEntry; entry: EntryData } | null,
): string | undefined {
  if (!selected) return undefined;
  const { intercept, entry } = selected;
  let position = 0;
  for (const other of entry.intercept) {
    if (other === intercept) break;
    if (
      other.slotName === intercept.slotName &&
      other.routeName === intercept.routeName
    ) {
      position++;
    }
  }
  return `${interceptSlotId(entry, intercept)}~${position}`;
}

/**
 * Every segment id an intercept's slot owns, in order: the slot, then one
 * loader segment per loader in declaration order, run or not. A request that
 * resolves the intercept lists them in `matched` (match-result.ts).
 */
export function interceptSegmentIds(
  parentEntry: EntryData,
  intercept: InterceptEntry,
): string[] {
  const slotId = interceptSlotId(parentEntry, intercept);
  return [
    slotId,
    ...intercept.loader.map((l, i) => `${slotId}D${i}.${l.loader.$$id}`),
  ];
}

/**
 * An intercept's loaders are loader segments of its slot, resolved through
 * the partial lane's funnel (revalidation.ts resolveOwnerLoaders): each one
 * revalidated on its own, kept in a fill, deferred by a prefetch when flagged.
 */
function resolveInterceptLoaders<TEnv>(
  pass: ResolutionPass<TEnv>,
  interceptEntry: InterceptEntry,
  parentEntry: EntryData,
  belongsToRoute: boolean,
): Promise<{ segments: ResolvedSegment[] }> {
  return resolveOwnerLoaders(
    pass,
    {
      loaders: interceptEntry.loader,
      namespace: `intercept:${interceptEntry.routeName}`,
      segmentPrefix: interceptSlotId(parentEntry, interceptEntry),
      boundary: parentEntry,
      bakeLane: false,
      traceSource: "intercept-loader",
    },
    belongsToRoute,
  );
}

/**
 * An intercept slot with no loading() waits for its loaders that are not
 * deferred; the browser's side is foldInterceptLoaders (segment-system.tsx).
 */
async function settleLoaderSegments(
  segments: readonly ResolvedSegment[],
): Promise<void> {
  await Promise.all(
    segments.filter((s) => !s.deferred).map((s) => s.loaderData),
  );
}

/**
 * Resolve an intercept entry: its slot segment, then its loader segments. The
 * background re-render resolves with a pass that holds nothing
 * (heldNothingPassInput, resolution-pass.ts): every segment renders fresh, and
 * its loaders are skipped (skipLoaders), each registered for the handler's
 * read.
 */
export async function resolveInterceptEntry<TEnv>(
  pass: ResolutionPass<TEnv>,
  interceptEntry: InterceptEntry,
  parentEntry: EntryData,
  belongsToRoute: boolean,
  options?: {
    /**
     * Set ONLY by the post-response background re-render (stale background
     * revalidation), whose sole purpose is to re-render the segment tree to
     * populate the cache: a handler error is reported, then rejects instead
     * of rendering the error boundary, so a failure is never cached. Never
     * set on the foreground path.
     */
    background?: boolean;
  },
): Promise<ResolvedSegment[]> {
  latchPprHeaderScopeForInterceptTarget(interceptEntry);

  const { context, params } = pass;
  const slotSegmentId = interceptSlotId(parentEntry, interceptEntry);
  const { segments: loaderSegments } = await resolveInterceptLoaders(
    pass,
    interceptEntry,
    parentEntry,
    belongsToRoute,
  );
  // The slot's tag scope (#957, cache-tag.ts runInSegmentTagScope) and the
  // owner of its handler's handle pushes (a handler's ctx.use(Handle) reads
  // it when called).
  (context as InternalHandlerContext<any, TEnv>)._currentSegmentId =
    slotSegmentId;

  const slotSegment = (
    component: ReactNode,
    layout: ReactNode | undefined,
  ): ResolvedSegment => ({
    id: slotSegmentId,
    namespace: `intercept:${interceptEntry.routeName}`,
    type: "parallel",
    index: 0,
    component,
    loading: interceptEntry.loading === false ? null : interceptEntry.loading,
    layout,
    params,
    slot: interceptEntry.slotName,
    belongsToRoute,
    parallelName: `intercept:${interceptEntry.routeName}.${interceptEntry.slotName}`,
  });

  // A fill keeps a slot the client holds: neither its handler nor its layout
  // runs, only the loaders the client lacks (match-result.ts leaves the null
  // slot out of the response).
  if (fillSends(context, slotSegmentId, pass.client) === false) {
    return [slotSegment(null, undefined), ...loaderSegments];
  }

  let handlerResult: ReactNode;
  try {
    const handler = interceptEntry.handler;
    handlerResult =
      typeof handler === "function"
        ? handleHandlerResult(
            runInSegmentTagScope(slotSegmentId, handler, context),
          )
        : handler;
  } catch (error) {
    handlerResult = renderInterceptHandlerError(
      pass,
      error,
      parentEntry,
      slotSegmentId,
      options?.background,
    );
  }
  // Consumed only after the layout and loader awaits below; a rejection in that
  // window would be an unhandledRejection (process crash on Node's default
  // mode). The later await / trackHandler still observes it.
  if (handlerResult instanceof Promise) handlerResult.catch(() => {});

  let layoutElement: ReactNode | undefined;
  if (interceptEntry.layout) {
    const layout = interceptEntry.layout;
    if (typeof layout === "function") {
      const layoutResult = await runInSegmentTagScope(
        slotSegmentId,
        layout,
        context,
      );
      if (layoutResult instanceof Response) {
        throw layoutResult;
      }
      layoutElement = layoutResult;
    } else {
      layoutElement = layout;
    }
  }

  let component: ReactNode;
  // A streamed (loading()) handler resolves after the 200 has started: tracked
  // like route handlers (onError report, handle-store completion) and
  // recovered into the declared boundary, except on the background
  // re-render, which must reject so a failure is never cached.
  const streamedComponent = (promise: Promise<unknown>): ReactNode =>
    trackStreamedHandler(pass.deps, promise, {
      boundaryEntry: parentEntry,
      segmentId: slotSegmentId,
      segmentType: "parallel",
      context,
      routeKey: interceptEntry.routeName,
      params,
      isPartial: true,
      recover: !options?.background,
    });

  if (interceptEntry.loading && loaderSegments.length > 0) {
    if (handlerResult instanceof Promise) {
      warnOnStreamedResponse(
        handlerResult,
        `intercept ${interceptEntry.slotName}`,
      );
    }
    component =
      handlerResult instanceof Promise
        ? streamedComponent(handlerResult)
        : (Promise.resolve(handlerResult) as ReactNode);
  } else if (interceptEntry.loading && handlerResult instanceof Promise) {
    component = streamedComponent(handlerResult);
  } else {
    if (!interceptEntry.loading) await settleLoaderSegments(loaderSegments);
    component = handlerResult;
    if (handlerResult instanceof Promise) {
      try {
        component = await handlerResult;
      } catch (error) {
        component = renderInterceptHandlerError(
          pass,
          error,
          parentEntry,
          slotSegmentId,
          options?.background,
        );
      }
    }
  }
  // After the handler is awaited, or at once when it streams: the loaders it
  // started with ctx.use() by now are delivered from this response.
  deliverStartedLoaders(context, loaderSegments);

  return [slotSegment(component, layoutElement), ...loaderSegments];
}

/**
 * The loader segments of a cached intercept slot, on a cache hit: the slot
 * keeps its cached component and layout, its loaders are never cached.
 */
export async function resolveInterceptLoadersOnly<TEnv>(
  pass: ResolutionPass<TEnv>,
  interceptEntry: InterceptEntry,
  parentEntry: EntryData,
  belongsToRoute: boolean,
): Promise<ResolvedSegment[]> {
  latchPprHeaderScopeForInterceptTarget(interceptEntry);
  const handleStore = _getRequestContext()?._handleStore;
  const { segments } = await resolveInterceptLoaders(
    pass,
    interceptEntry,
    parentEntry,
    belongsToRoute,
  );
  // Where resolveInterceptEntry runs the handler.
  handleStore?.releaseRecordedValues(
    interceptSlotId(parentEntry, interceptEntry),
  );
  if (!interceptEntry.loading) await settleLoaderSegments(segments);
  deliverStartedLoaders(pass.context, segments);
  return segments;
}
