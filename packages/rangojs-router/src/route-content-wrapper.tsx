"use client";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { Component, Suspense, use } from "react";
import { AuditedOutletProvider, OutletProvider } from "./outlet-provider.js";
import type { ResolvedSegment } from "./types.js";
import {
  decodeLoaderResults,
  LOADER_ERROR_FALLBACK,
  LOADER_NOT_FOUND_FALLBACK,
  LOADER_REDIRECT,
} from "./decode-loader-results.js";
import { LoaderRedirect } from "./loader-redirect.js";
import type { BoundaryAudit } from "./suspense-audit.js";
import {
  AuditedFallback,
  useBoundaryAudit,
  useRevealAudit,
} from "./suspense-audit-react.js";

/**
 * Router-owned error boundary for read-site loader errors. segment-system
 * wraps every loader-bearing segment's children in one (unconditionally —
 * streams and forceAwait lanes alike, so the tree shape never differs between
 * navigation lanes; see docs/tree-structure.md). A loader error thrown by a
 * suspending read carries its errorBoundary() fallback via
 * LOADER_ERROR_FALLBACK (decodeLoaderEntry); this boundary renders that node,
 * restoring the pre-streaming errorFallback-swap contract.
 *
 * Loader-thrown AUTHORITY SIGNALS ride sibling markers:
 * - LOADER_NOT_FOUND_FALLBACK (notFound()): renders the SERVER-RENDERED
 *   not-found UI carried on the marker — nearest notFoundBoundary → router
 *   notFound option — zero extra fetches. Document lane: Fizz emitted the
 *   Suspense fallback and replays the throw at hydration, so the swap happens
 *   client-side (the HTTP status was already set opportunistically by the
 *   producer when the rejection won the flush race).
 * - LOADER_REDIRECT (redirect()): mounts LoaderRedirect, which navigates.
 *
 * Errors without any marker rethrow to the app's own boundaries.
 */
export class StreamedLoaderErrorBoundary extends Component<
  { children: ReactNode; resetKey?: string },
  { error: unknown; resetKey?: string }
> {
  state: { error: unknown; resetKey?: string } = {
    error: null,
    resetKey: this.props.resetKey,
  };

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }

  /**
   * A caught marker (redirect, notFound, error fallback) belongs to ONE route
   * + params. Group-keyed segments (ResolvedSegment.clientGroup) keep this
   * instance alive across in-group navigations, so the error must clear when
   * the route or params change — otherwise a redirect caught for /legacy
   * keeps rendering LoaderRedirect for /state. `resetKey` is the segment's
   * id-params identity, the cadence the per-route remount used to provide.
   */
  static getDerivedStateFromProps(
    props: { resetKey?: string },
    state: { error: unknown; resetKey?: string },
  ): { error: unknown; resetKey?: string } | null {
    if (props.resetKey !== state.resetKey) {
      return { error: null, resetKey: props.resetKey };
    }
    return null;
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error !== null && error !== undefined) {
      const marked = error as Record<PropertyKey, unknown>;
      const notFoundFallback = marked[LOADER_NOT_FOUND_FALLBACK];
      if (notFoundFallback !== undefined) return notFoundFallback as ReactNode;
      const redirect = marked[LOADER_REDIRECT];
      if (redirect !== undefined) {
        const r = redirect as { to: string; state?: Record<string, unknown> };
        return <LoaderRedirect to={r.to} state={r.state} />;
      }
      const fallback = marked[LOADER_ERROR_FALLBACK];
      if (fallback !== undefined) return fallback as ReactNode;
      throw error;
    }
    return this.props.children;
  }
}

/**
 * Stable async wrapper component for route content
 * Using a module-level component ensures React sees the same component reference
 * across renders, preventing unnecessary remounts during actions.
 *
 * When content is a pending promise, React suspends and shows the nearest
 * Suspense fallback. When content is already resolved, it renders immediately
 * without suspension.
 *
 * @param segmentId - Stable ID from segment, used for consistent keys across renders
 */
export function RouteContentWrapper({
  content,
  fallback,
  segmentId,
}: {
  // A pending promise suspends (use()) and shows the fallback; a node renders
  // without suspending (see getBoundaryContent).
  content: Promise<ReactNode> | ReactNode;
  fallback?: ReactNode;
  segmentId?: string;
}): ReactNode {
  return (
    <Suspense
      fallback={fallback ?? null}
      key={segmentId ? "route-content-suspense-" + segmentId : undefined}
    >
      <Suspender content={content} key={segmentId} />
    </Suspense>
  );
}

// Dev only (suspense-audit.ts): RouteContentWrapper's Suspense, keys and
// content, with the audit's hooks in components of their own.
//
// Chosen where the element is created, inside a NODE_ENV test, so a build
// folds to the product component and nothing else. Two other ways leave
// bytes in cloudflare-basic's router chunk, both measured: a dev branch
// inside the product component (React Compiler runs before NODE_ENV is
// folded and keeps the branch's memo slots, +76 B gzip), and one
// `export const X = dev ? Audited : Product` per module (the alias statement
// survives minification, +27 B gzip for three).
//
// Line comments on purpose, here and on the other dev-only declarations: the
// server bundles are not minified and keep a JSDoc block even when the
// declaration under it is removed.
export function AuditedRouteContent({
  content,
  fallback,
  segmentId,
}: ComponentProps<typeof RouteContentWrapper>): ReactNode {
  const audit = useBoundaryAudit(
    `content:${segmentId}`,
    segmentId ?? "",
    content,
  );
  return (
    <Suspense
      fallback={
        <AuditedFallback audit={audit}>{fallback ?? null}</AuditedFallback>
      }
      key={segmentId ? "route-content-suspense-" + segmentId : undefined}
    >
      <AuditedSuspender content={content} audit={audit} key={segmentId} />
    </Suspense>
  );
}

function AuditedSuspender({
  content,
  audit,
}: {
  content: Promise<ReactNode> | ReactNode;
  audit: BoundaryAudit;
}): ReactNode {
  useRevealAudit(audit);
  return Suspender({ content });
}

const Suspender = ({
  content,
}: {
  content: Promise<ReactNode> | ReactNode;
}): ReactNode => {
  // A pending promise suspends here and the wrapping Suspense shows the
  // loading() fallback; a node renders without suspending. The wrapper tree
  // (RouteContentWrapper > Suspense > Suspender) is identical either way (see
  // docs/tree-structure.md), like LoaderResolver's resolved-data branch.
  return content instanceof Promise ? use(content) : content;
};

/**
 * LoaderBoundary - Client component that resolves loader promises and renders OutletProvider
 *
 * This component enables streaming with loaders by:
 * 1. Receiving loader promises (serializable across RSC boundary)
 * 2. Using React's use() to resolve them (triggers Suspense)
 * 3. Rendering OutletProvider with resolved data
 *
 * The callback logic lives inside this client component, avoiding the
 * "Functions are not valid as a child of Client Components" error.
 */
export interface LoaderBoundaryProps {
  loaderDataPromise: Promise<any[]> | any[];
  loaderIds: string[];
  /**
   * SPIKE (streaming useLoader): per-loader UNDECODED results from the
   * producer (values or individually-pending promises). When present, the
   * resolver passes them through instead of resolving the aggregate above
   * the children; useLoader suspends per loader at the read site.
   */
  loaderStreams?: Record<string, unknown>;
  /** Dev-diagnostic input for the SSR suspension warning — see
   *  OutletContextValue.awaitedLoaderIds. Rides the streams lane only. */
  awaitedLoaderIds?: readonly string[];
  fallback?: ReactNode;
  outletKey: string;
  outletContent: ReactNode;
  segment: ResolvedSegment;
  parallel?: ResolvedSegment[];
  children: ReactNode;
}

export function LoaderBoundary({
  loaderDataPromise,
  loaderIds,
  loaderStreams,
  awaitedLoaderIds,
  fallback,
  outletKey,
  outletContent,
  segment,
  parallel,
  children,
}: LoaderBoundaryProps): ReactNode {
  return (
    <Suspense fallback={fallback ?? null} key={`loader-boundary-${outletKey}`}>
      <LoaderResolver
        loaderDataPromise={loaderDataPromise}
        loaderIds={loaderIds}
        loaderStreams={loaderStreams}
        awaitedLoaderIds={awaitedLoaderIds}
        outletKey={outletKey}
        outletContent={outletContent}
        segment={segment}
        parallel={parallel}
      >
        {children}
      </LoaderResolver>
    </Suspense>
  );
}

// Dev only (suspense-audit.ts): LoaderBoundary, as AuditedRouteContent.
export function AuditedLoaderBoundary({
  fallback,
  children,
  ...resolver
}: LoaderBoundaryProps): ReactNode {
  const audit = useBoundaryAudit(
    `loaders:${resolver.outletKey}`,
    resolver.segment.id,
    resolver.loaderDataPromise,
    resolver.loaderStreams,
    [children, resolver.outletContent],
  );
  return (
    <Suspense
      fallback={
        <AuditedFallback audit={audit}>{fallback ?? null}</AuditedFallback>
      }
      key={`loader-boundary-${resolver.outletKey}`}
    >
      <AuditedLoaderResolver audit={audit} {...resolver}>
        {children}
      </AuditedLoaderResolver>
    </Suspense>
  );
}

function AuditedLoaderResolver({
  audit,
  ...props
}: Omit<LoaderBoundaryProps, "fallback"> & {
  audit: BoundaryAudit;
}): ReactNode {
  useRevealAudit(audit);
  // The resolver's OutletProvider, as its audited component.
  const outlet = LoaderResolver(props) as ReactElement<
    ComponentProps<typeof OutletProvider>
  >;
  return <AuditedOutletProvider {...outlet.props} key={outlet.key} />;
}

/**
 * Internal component that resolves loader promises and renders OutletProvider
 *
 * SPIKE (streaming useLoader): when the producer provides per-loader streams,
 * nothing resolves here above the children — the streams pass through
 * OutletProvider and useLoader suspends at the read site, with the
 * LoaderBoundary's loading() fallback as the catching boundary. The streams
 * MUST be per-loader promises from the producer: deriving them by splitting
 * the aggregate (aggregate.then(r => r[i])) is wrong — Promise.all resolves
 * at the SLOWEST loader, so every derived promise inherits the slowest
 * timing and per-loader granularity is erased (measured: a 400ms loader's
 * content held until a 2000ms sibling resolved).
 *
 * Without streams, the pre-spike behavior is preserved: a pending aggregate
 * resolves ABOVE via use() (parallel/intercept slots still take this path —
 * ResolvedSegment carries only the aggregate for slots), and a resolved
 * array decodes synchronously (forceAwait/action lanes commit whole).
 */
function LoaderResolver({
  loaderDataPromise,
  loaderIds,
  loaderStreams,
  awaitedLoaderIds,
  outletKey,
  outletContent,
  segment,
  parallel,
  children,
}: Omit<LoaderBoundaryProps, "fallback">): ReactNode {
  if (loaderStreams) {
    return (
      <OutletProvider
        key={outletKey}
        content={outletContent}
        segment={segment}
        parallel={parallel}
        loaderStreams={loaderStreams}
        awaitedLoaderIds={awaitedLoaderIds}
      >
        {children}
      </OutletProvider>
    );
  }

  const resolvedData =
    loaderDataPromise instanceof Promise
      ? use(loaderDataPromise)
      : loaderDataPromise;

  const { loaderData, errorFallback } = decodeLoaderResults(
    resolvedData,
    loaderIds,
  );

  return (
    <OutletProvider
      key={outletKey}
      content={outletContent}
      segment={segment}
      parallel={parallel}
      loaderData={Object.keys(loaderData).length > 0 ? loaderData : undefined}
    >
      {errorFallback ?? children}
    </OutletProvider>
  );
}
