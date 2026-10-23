/**
 * The fresh walker (fresh.ts resolveAllSegments) against the revalidating
 * walker (revalidation.ts resolveAllSegmentsWithRevalidation) when the
 * client holds nothing: the same route, one pass each, each with a handler
 * context built the same way. They agree segment for segment except for the
 * differences named below. When the fresh walk becomes a pass of the
 * revalidating walker, each named difference becomes an explicit branch of
 * that pass, and this file stays green with the same list.
 *
 * Both walkers run as the router runs them: a router built from the DSL, the
 * RouterContext its match builds (its deps, findMatch, handler contexts and
 * loader access), entries from resolveRoute, and the DSL store around the
 * walk. Each case runs on both manifest partitions (document, isSSR true,
 * and navigation, isSSR false), which differ for `loading(..., { ssr: false })`.
 *
 * walkFresh() and walkRevalidating() are the only calls of the two walkers:
 * a change to either signature lands there.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createElement, isValidElement, type ReactNode } from "react";
import { createRouter } from "../../../router.js";
import { createLoader } from "../../../loader.rsc.js";
import { urls } from "../../../urls.js";
import { buildRouterTrieFromUrlpatterns } from "../../../rsc/manifest-init.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../../server/request-context.js";
import { getContext, type EntryData } from "../../../server/context.js";
import {
  getRouterContext,
  runWithRouterContext,
  type RouterContext,
} from "../../router-context.js";
import { resolveRoute, type RouteSnapshot } from "../../route-snapshot.js";
import { createPrerenderContext } from "../../handler-context.js";
import { setupBuildUse } from "../../loader-resolution.js";
import type { HandlerContext, ResolvedSegment } from "../../../types.js";

const DataLoader = (createLoader as Function)(
  async () => ({ value: "data" }),
  undefined,
  "walker#Data",
);
const SlotLoader = (createLoader as Function)(
  async () => ({ value: "slot" }),
  undefined,
  "walker#Slot",
);

const el = (tag: string, text: string): ReactNode =>
  createElement(tag, null, text);
const Spinner = el("i", "spinner");

/** The RouterContext the router's own match built, captured by /probe. */
let routerCtx: RouterContext;

const included = urls(({ path, loader }) => [
  path(
    "/page",
    () => el("p", "included"),
    { name: "page" },
    () => [loader(DataLoader)],
  ),
]);

beforeAll(async () => {
  const router = createRouter({});
  router.routes(
    ({
      layout,
      path,
      loader,
      loading,
      parallel,
      include,
      intercept,
      cache,
      errorBoundary,
    }) => [
      layout(
        () => el("div", "root"),
        () => [
          path(
            "/probe",
            () => {
              routerCtx = getRouterContext();
              return null;
            },
            { name: "probe" },
          ),
          path("/plain", () => el("p", "plain"), { name: "plain" }),
          path(
            "/loading-undefined",
            () => el("p", "loading undefined"),
            { name: "loadingUndefined" },
            () => [loader(DataLoader)],
          ),
          path(
            "/loading-false",
            () => el("p", "loading false"),
            { name: "loadingFalse" },
            () => [loader(DataLoader), loading(false)],
          ),
          path(
            "/loading-truthy",
            () => el("p", "loading truthy"),
            { name: "loadingTruthy" },
            () => [loader(DataLoader), loading(Spinner)],
          ),
          path(
            "/loading-ssr-false",
            () => el("p", "loading ssr false"),
            { name: "loadingSsrFalse" },
            () => [loader(DataLoader), loading(Spinner, { ssr: false })],
          ),
          path(
            "/streamed",
            async () => el("p", "streamed"),
            { name: "streamed" },
            () => [loading(Spinner)],
          ),
          layout(
            () => el("section", "slots"),
            () => [
              parallel({ "@side": () => el("aside", "side") }, () => [
                loader(SlotLoader),
                loading(Spinner),
              ]),
              path("/parallel", () => el("p", "parallel"), {
                name: "parallel",
              }),
            ],
          ),
          // A layout among a route's children: an orphan of the route that
          // inherits the route's loaders for its slot.
          path(
            "/orphan",
            () => el("p", "orphan"),
            { name: "orphan" },
            () => [
              loader(DataLoader),
              layout(
                () => el("nav", "orphan layout"),
                () => [parallel({ "@aside": () => el("aside", "aside") })],
              ),
            ],
          ),
          // #918: a layout after a bare cache() marker. For the route before
          // the marker it is a routeless entry nested in an orphan (the
          // marker); for the route after it, an orphan of the marker.
          layout(
            () => el("main", "host"),
            () => [
              path("/before-marker", () => el("p", "before"), {
                name: "beforeMarker",
              }),
              cache(),
              layout(() => el("nav", "nested routeless")),
              path("/after-marker", () => el("p", "after"), {
                name: "afterMarker",
              }),
            ],
          ),
          include("/inc", included, { name: "inc" }),
          layout(
            () => el("main", "gallery"),
            () => [
              path("/gallery", () => el("p", "gallery"), { name: "gallery" }),
              path(
                "/photo/:id",
                () => el("p", "photo"),
                { name: "photo" },
                () => [loader(DataLoader)],
              ),
              intercept("@modal", "photo", () => el("dialog", "modal")),
            ],
          ),
          path(
            "/throws",
            () => {
              throw new Error("handler failed");
            },
            { name: "throws" },
            () => [errorBoundary(el("p", "route failed"))],
          ),
        ],
      ),
    ],
  );
  await buildRouterTrieFromUrlpatterns(router);
  const request = new Request("https://example.com/probe");
  // match() is the internal router surface the RSC handler calls.
  const internal = router as unknown as {
    match(request: Request, input: { env: object }): Promise<unknown>;
  };
  await runWithRequestContext(
    createRequestContext({
      env: {},
      request,
      url: new URL(request.url),
      variables: {},
    }),
    () => internal.match(request, { env: {} }),
  );
});

// ---------------------------------------------------------------------------
// One walk
// ---------------------------------------------------------------------------

/** A segment as later stages read it: values settled, errors by message. */
type Projected = Record<string, unknown>;

/**
 * A value as data the two walks can be compared on: promises settled, an
 * element as its type, key and props, collections by their entries, a
 * function by its name.
 */
async function settled(value: unknown): Promise<unknown> {
  if (value instanceof Promise) return { promise: await settled(await value) };
  if (isValidElement(value)) {
    const type = value.type as string | { name?: string };
    return {
      element: typeof type === "string" ? type : (type.name ?? String(type)),
      key: value.key,
      props: await settled(value.props),
    };
  }
  if (Array.isArray(value)) return Promise.all(value.map(settled));
  if (value instanceof Map) return { map: await settled([...value]) };
  if (value instanceof Set) return { set: await settled([...value]) };
  if (typeof value === "function") return `function ${value.name}`;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [field, inner] of Object.entries(value)) {
      out[field] = await settled(inner);
    }
    return out;
  }
  return value;
}

async function project(segment: ResolvedSegment): Promise<Projected> {
  const out: Projected = {};
  for (const [field, value] of Object.entries(segment)) {
    if (field === "error") {
      const { message, segmentId, segmentType } = value as Record<
        string,
        unknown
      >;
      out.error = { message, segmentId, segmentType };
    } else {
      out[field] = await settled(value);
    }
  }
  return out;
}

interface Walk {
  segments: Projected[];
  /** What match middleware records as the matched ids. */
  matchedIds: string[];
  /** The message of what the walk threw, if it threw. */
  threw?: string;
}

interface Pass {
  pathname: string;
  snapshot: RouteSnapshot;
  context: HandlerContext<any>;
  request: Request;
  url: URL;
  build: boolean;
  intercept: boolean;
}

function walkFresh(pass: Pass): Promise<ResolvedSegment[]> {
  return routerCtx.resolveAllSegments(
    pass.snapshot.entries,
    pass.snapshot.routeKey,
    pass.snapshot.params,
    pass.context,
    new Map(),
    // What prerender-match.ts passes at build time.
    pass.build ? { skipLoaders: true, throwOnError: true } : undefined,
  );
}

function walkRevalidating(
  pass: Pass,
): Promise<{ segments: ResolvedSegment[]; matchedIds: string[] }> {
  // A navigation from /gallery, the page the intercept is declared beside.
  const from = new URL("/gallery", pass.url);
  const interceptResult = pass.intercept
    ? routerCtx.findInterceptForRoute(
        pass.snapshot.routeKey,
        pass.snapshot.manifestEntry.parent as EntryData,
        {
          from: { url: from, params: {}, routeName: "gallery" },
          to: {
            url: pass.url,
            params: pass.snapshot.params,
            routeName: pass.snapshot.routeKey,
          },
          request: pass.request,
          env: {},
          segments: { path: ["gallery"], ids: [] },
        },
        false,
      )
    : null;
  if (pass.intercept) expect(interceptResult).not.toBeNull();
  return routerCtx.resolveAllSegmentsWithRevalidation(
    pass.snapshot.entries,
    pass.snapshot.routeKey,
    pass.snapshot.params,
    pass.context,
    new Set(),
    {},
    pass.request,
    pass.url,
    pass.url,
    undefined,
    interceptResult,
    pass.snapshot.localRouteName,
    pass.pathname,
  );
}

/**
 * One walk of `pathname` in a request of its own, with a handler context
 * built as match-api.ts builds it, or at build time as prerender-match.ts
 * builds it (a prerender context whose `request` getter throws).
 */
async function walk(
  walker: "fresh" | "revalidating",
  pathname: string,
  options: { isSSR: boolean; build: boolean; intercept: boolean },
): Promise<Walk> {
  const request = new Request(
    options.build
      ? `http://prerender${pathname}`
      : `https://example.com${pathname}`,
  );
  const url = new URL(request.url);
  const requestContext = createRequestContext({
    env: {},
    request,
    url,
    variables: {},
  });
  return runWithRequestContext(requestContext, () =>
    runWithRouterContext(routerCtx, async () => {
      const resolved = await resolveRoute(pathname, {
        findMatch: (p) => routerCtx.findMatch(p),
        isSSR: options.isSSR,
      });
      if (resolved?.type !== "match") throw new Error(`no route: ${pathname}`);
      const snapshot = resolved.snapshot;
      let context: HandlerContext<any>;
      if (options.build) {
        context = createPrerenderContext(
          snapshot.params,
          pathname,
          {},
          snapshot.routeKey,
          {},
        );
        setupBuildUse(context);
      } else {
        context = routerCtx.createHandlerContext(
          snapshot.params,
          request,
          url.searchParams,
          pathname,
          url,
          {},
          {},
          snapshot.routeKey,
          snapshot.responseType,
          false,
        );
        routerCtx.setupLoaderAccess(context, new Map());
      }
      const pass: Pass = {
        pathname,
        snapshot,
        context,
        request,
        url,
        ...options,
      };
      const store = getContext().getOrCreateStore(snapshot.routeKey);
      const inStore = <T>(fn: () => Promise<T>): Promise<T> =>
        getContext().runWithStore(
          store,
          store.namespace || "#router",
          store.parent,
          fn,
        );
      try {
        if (walker === "fresh") {
          const segments = await inStore(() => walkFresh(pass));
          return {
            segments: await Promise.all(segments.map(project)),
            matchedIds: segments.map((s) => s.id),
          };
        }
        const result = await inStore(() => walkRevalidating(pass));
        return {
          segments: await Promise.all(result.segments.map(project)),
          matchedIds: result.matchedIds,
        };
      } catch (error) {
        return {
          segments: [],
          matchedIds: [],
          threw: (error as Error).message,
        };
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// The differences, by name
// ---------------------------------------------------------------------------

/**
 * Every difference between the two walks, grouped under the name of the
 * exception it is. Anything no exception names lands under "unnamed".
 */
type Differences = Partial<Record<Exception | "unnamed", string[]>>;

type Exception =
  /**
   * The revalidating walker marks a segment whose handler it ran
   * (`_handlerRan`, read by match-result.ts); the fresh walker never sets
   * it. Neither marks an orphan layout or an error segment.
   */
  | "handler ran marker"
  /**
   * The fresh walker tags a slot's loaders with the slot's loading()
   * (`parallelLoading`); the revalidating walker leaves it to
   * restoreParallelLoaderMarkers (segment-system.tsx).
   */
  | "slot loading tag"
  /**
   * Under an intercept the revalidating walker skips the intercepted
   * route's entry (its handler and loaders) and lists only the route's id
   * as matched.
   */
  | "skipped under intercept"
  /**
   * At build time the fresh walker skips loaders (skipLoaders); the
   * revalidating walker has no such option, so a route with a loader runs
   * the loader path, whose error context reads the prerender context's
   * throwing `request` getter (helpers.ts buildLoaderErrorContext), and the
   * route becomes an error segment.
   */
  | "build-time loaders"
  /**
   * At build time the fresh walker rethrows a handler error (throwOnError);
   * the revalidating walker renders the route's error segment.
   */
  | "build-time handler error";

function differences(
  fresh: Walk,
  revalidating: Walk,
  options: { build: boolean; intercept: boolean },
): Differences {
  const out: Differences = {};
  const add = (name: Exception | "unnamed", line: string): void => {
    (out[name] ??= []).push(line);
  };

  if (fresh.threw !== undefined || revalidating.threw !== undefined) {
    const errorSegments = revalidating.segments
      .filter((s) => s.type === "error")
      .map((s) => `${s.id}: ${(s.error as { message: string }).message}`);
    if (options.build && fresh.threw !== undefined && !revalidating.threw) {
      add(
        "build-time handler error",
        `fresh threw "${fresh.threw}"; revalidating rendered ${errorSegments.join(", ")}`,
      );
    } else {
      add("unnamed", `threw: ${fresh.threw} | ${revalidating.threw}`);
    }
    return out;
  }

  const freshById = new Map(fresh.segments.map((s) => [s.id as string, s]));
  const revalidatingById = new Map(
    revalidating.segments.map((s) => [s.id as string, s]),
  );
  for (const id of freshById.keys()) {
    if (revalidatingById.has(id)) continue;
    add(options.intercept ? "skipped under intercept" : "unnamed", id);
  }
  for (const id of revalidatingById.keys()) {
    if (!freshById.has(id)) add("unnamed", `revalidating only: ${id}`);
  }
  const freshOrder = [...freshById.keys()].filter((id) =>
    revalidatingById.has(id),
  );
  const revalidatingOrder = [...revalidatingById.keys()].filter((id) =>
    freshById.has(id),
  );
  if (freshOrder.join() !== revalidatingOrder.join()) {
    add("unnamed", `order: ${freshOrder.join()} | ${revalidatingOrder.join()}`);
  }

  for (const [id, f] of freshById) {
    const r = revalidatingById.get(id);
    if (!r) continue;
    if (options.build && f.type === "route" && r.type === "error") {
      add(
        "build-time loaders",
        `${id}: ${(r.error as { message: string }).message}`,
      );
      continue;
    }
    for (const field of new Set([...Object.keys(f), ...Object.keys(r)])) {
      const a = JSON.stringify(f[field]);
      const b = JSON.stringify(r[field]);
      if (a === b) continue;
      if (field === "_handlerRan" && a === undefined && b === "true") {
        add("handler ran marker", id);
      } else if (field === "parallelLoading" && b === undefined) {
        add("slot loading tag", id);
      } else {
        add("unnamed", `${id}.${field}: ${a} -> ${b}`);
      }
    }
  }

  const matchedOnlyFresh = fresh.matchedIds.filter(
    (id) => !revalidating.matchedIds.includes(id),
  );
  const matchedOnlyRevalidating = revalidating.matchedIds.filter(
    (id) => !fresh.matchedIds.includes(id),
  );
  for (const id of matchedOnlyFresh) {
    add(
      options.intercept ? "skipped under intercept" : "unnamed",
      `not matched: ${id}`,
    );
  }
  for (const id of matchedOnlyRevalidating) {
    add("unnamed", `matched by revalidating only: ${id}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cases (docs/tree-structure.md shapes, plus build time and intercept)
// ---------------------------------------------------------------------------

interface Case {
  name: string;
  pathname: string;
  build?: boolean;
  intercept?: boolean;
  expected: Differences;
}

const CASES: Case[] = [
  {
    name: "plain route",
    pathname: "/plain",
    expected: { "handler ran marker": ["M0L0", "M0L0L0", "M0L0L0R1"] },
  },
  {
    name: "loading undefined, with a loader",
    pathname: "/loading-undefined",
    expected: { "handler ran marker": ["M0L0", "M0L0L0", "M0L0L0R2"] },
  },
  {
    name: "loading(false), with a loader",
    pathname: "/loading-false",
    expected: { "handler ran marker": ["M0L0", "M0L0L0", "M0L0L0R3"] },
  },
  {
    name: "loading(truthy), with a loader",
    pathname: "/loading-truthy",
    expected: { "handler ran marker": ["M0L0", "M0L0L0", "M0L0L0R4"] },
  },
  {
    name: "loading(..., { ssr: false }), with a loader",
    pathname: "/loading-ssr-false",
    expected: { "handler ran marker": ["M0L0", "M0L0L0", "M0L0L0R5"] },
  },
  {
    name: "loading(truthy), async handler",
    pathname: "/streamed",
    expected: { "handler ran marker": ["M0L0", "M0L0L0", "M0L0L0R6"] },
  },
  {
    name: "parallel slot with a loader and loading()",
    pathname: "/parallel",
    expected: {
      "handler ran marker": [
        "M0L0",
        "M0L0L0",
        "M0L0L0L0",
        "M0L0L0L0.@side",
        "M0L0L0L0R0",
      ],
      "slot loading tag": ["M0L0L0L0D0.walker#Slot"],
    },
  },
  {
    name: "orphan layout with a slot, inheriting the route's loaders",
    pathname: "/orphan",
    expected: {
      "handler ran marker": ["M0L0", "M0L0L0", "M0L0L0R7L0.@aside", "M0L0L0R7"],
    },
  },
  {
    name: "routeless layout nested in a cache() marker (#918), route before the marker",
    pathname: "/before-marker",
    expected: {
      "handler ran marker": ["M0L0", "M0L0L0", "M0L0L0L1", "M0L0L0L1R0"],
    },
  },
  {
    name: "routeless layout after a cache() marker (#918), route after the marker",
    pathname: "/after-marker",
    expected: {
      "handler ran marker": [
        "M0L0",
        "M0L0L0",
        "M0L0L0L1",
        "M0L0L0L1C0",
        "M0L0L0L1C0R0",
      ],
    },
  },
  {
    name: "include()",
    pathname: "/inc/page",
    expected: { "handler ran marker": ["M0L0", "M0L0L0", "M0L0L0I0R0"] },
  },
  {
    name: "intercepted route",
    pathname: "/photo/1",
    intercept: true,
    expected: {
      "handler ran marker": ["M0L0", "M0L0L0", "M0L0L0L2"],
      "skipped under intercept": [
        "M0L0L0L2R1D0.walker#Data",
        "M0L0L0L2R1",
        "not matched: M0L0L0L2R1D0.walker#Data",
      ],
    },
  },
  {
    name: "the same route, not intercepted",
    pathname: "/photo/1",
    expected: {
      "handler ran marker": ["M0L0", "M0L0L0", "M0L0L0L2", "M0L0L0L2R1"],
    },
  },
  {
    name: "handler error",
    pathname: "/throws",
    expected: { "handler ran marker": ["M0L0", "M0L0L0"] },
  },
  {
    name: "build time, no loader",
    pathname: "/plain",
    build: true,
    expected: { "handler ran marker": ["M0L0", "M0L0L0", "M0L0L0R1"] },
  },
  {
    name: "build time, a loader",
    pathname: "/loading-truthy",
    build: true,
    expected: {
      "handler ran marker": ["M0L0", "M0L0L0"],
      "build-time loaders": [
        'M0L0L0R4: Property "request" is not available during pre-rendering. Fetch data directly in the handler or use a passthrough prerender handler.',
      ],
    },
  },
  {
    name: "build time, handler error",
    pathname: "/throws",
    build: true,
    expected: {
      "build-time handler error": [
        'fresh threw "handler failed"; revalidating rendered M0L0L0R8: handler failed',
      ],
    },
  },
];

describe("fresh vs revalidating walker, nothing held by the client", () => {
  describe.each([
    ["document manifest (isSSR)", true],
    ["navigation manifest", false],
  ])("%s", (_partition, isSSR) => {
    it.each(CASES)(
      "$name: only the named differences",
      async ({ pathname, build = false, intercept = false, expected }) => {
        const options = { isSSR, build, intercept };
        const fresh = await walk("fresh", pathname, options);
        const revalidating = await walk("revalidating", pathname, options);
        expect(differences(fresh, revalidating, options)).toEqual(expected);
      },
    );
  });
});
