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
import { getRouterContext } from "./router-context.js";
import { runInSegmentTagScope } from "../cache/cache-tag.js";
import {
  RangoContext,
  latchPprHeaderScopeForEntries,
} from "../server/context.js";

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
 *
 * During action revalidation, when() is NOT evaluated.
 */
export function evaluateInterceptWhen(
  intercept: InterceptEntry,
  selectorContext: InterceptSelectorContext | null,
  isAction: boolean,
): boolean {
  if (isAction) {
    return true;
  }

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
 * Find an intercept for the target route by walking up the entry chain.
 * Returns the first (innermost) matching intercept along with the entry that defines it.
 */
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
  // Tolerate partial entries (unit-test mocks omit the arrays); real
  // registration always populates layout/intercept.
  const add = (source: EntryData): undefined => {
    for (const intercept of source.intercept ?? []) {
      names.add(intercept.routeName);
    }
    return undefined;
  };
  let current: EntryData | null = fromEntry;
  let prev: EntryData | null = null;
  while (current) {
    add(current);
    findInOrphans(current, add, prev);
    prev = current;
    current = current.parent;
  }
  return [...names];
}

export function findInterceptForRoute(
  targetRouteKey: string,
  fromEntry: EntryData | null,
  selectorContext: InterceptSelectorContext | null = null,
  isAction: boolean = false,
): { intercept: InterceptEntry; entry: EntryData } | null {
  const match = (source: EntryData) => {
    for (const intercept of source.intercept) {
      if (
        intercept.routeName === targetRouteKey &&
        evaluateInterceptWhen(intercept, selectorContext, isAction)
      ) {
        return { intercept, entry: source };
      }
    }
    return undefined;
  };
  let current: EntryData | null = fromEntry;
  let prev: EntryData | null = null;

  while (current) {
    // current first, then its orphans (nested ones included) in render order.
    const found = match(current) ?? findInOrphans(current, match, prev);
    if (found) return found;

    prev = current;
    current = current.parent;
  }

  return null;
}

/**
 * An intercept handler's throw or notFound() renders the declaring entry's
 * boundary as the slot component (catchSegmentError, as for route handlers on
 * partial navigations: 500/404 status, onError "handler"). Responses and every
 * error on the background re-render (`background`) rethrow, so a failed
 * re-render aborts its cache write instead of storing the fallback.
 */
function renderInterceptHandlerError<TEnv>(
  pass: ResolutionPass<TEnv>,
  error: unknown,
  parentEntry: EntryData,
  background: boolean | undefined,
): ReactNode {
  if (error instanceof Response || background) throw error;
  return catchSegmentError(
    error,
    parentEntry,
    pass.params,
    pass.deps,
    {
      ...buildLoaderErrorContext(pass.context),
      isPartial: true,
      telemetry: getRouterContext()?.telemetry,
    },
    pass.context.pathname,
  ).component;
}

/** The segment id of `intercept`'s slot on `parentEntry`. */
export function interceptSlotId(
  parentEntry: EntryData,
  intercept: InterceptEntry,
): string {
  return `${parentEntry.shortCode}.${intercept.slotName}`;
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
 * (heldNothingPassInput, resolution-pass.ts): every segment renders fresh.
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
     * populate the cache: a handler error rejects instead of rendering the
     * error boundary, so a failure is never cached. Never set on the
     * foreground path.
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
  const { segments } = await resolveInterceptLoaders(
    pass,
    interceptEntry,
    parentEntry,
    belongsToRoute,
  );
  if (!interceptEntry.loading) await settleLoaderSegments(segments);
  deliverStartedLoaders(pass.context, segments);
  return segments;
}
