/**
 * One browser tab over serveShellRequest, for the source-independence tests
 * (#1331): the page on screen, its history entries, its prefetches and its
 * clicks.
 *
 * Driven through production code:
 * - the server: every request is serveShellRequest, the production handler,
 *   with the URL params and headers browser/navigation-client.ts and
 *   browser/prefetch/fetch.ts send (writePartialParams, the prefetch header,
 *   X-RSC-Router-Client-Path);
 * - the prefetch cache (browser/prefetch/cache.ts): the keys
 *   (buildSourceKey, buildPrefetchKey, paramsCandidateKeys), the slot a
 *   prefetch is stored in (prefetchStorageSlot, prefetch/fetch.ts) and the
 *   slot a click adopts from (consumeStoredPrefetch, navigation-client.ts),
 *   with the page on screen's params and route name as the router store
 *   commits them (the answer's metadata);
 * - reconcileSegments (browser/segment-reconciler.ts).
 *
 * Restated, and pinned to production by prefetch-browser-commit.test.tsx
 * (the real bridge and partial updater on the same inputs): the commit and
 * the history-entry merge (helpers/browser-commit.ts). Both live in
 * hook-locked files.
 *
 * Not modelled:
 * - the clientUrls() optimistic frame a click paints before the answer;
 * - adoption of a prefetch still in flight (pinned by
 *   navigation-client.test.ts "shared in-flight entry that turns out
 *   source-scoped");
 * - the canUsePrefetch gates (stale, HMR, fill, intercept source): a link
 *   click passes none;
 * - handle values: serveShellRequest exposes an answer's own handles, but
 *   the merge with the pushes the page keeps lives in hook-locked
 *   event-controller.ts and navigation-bridge.ts (pinned by
 *   history-cache-handle-base.test.tsx);
 * - a history entry the server marked stale, and the intercept cache
 *   (store.hasInterceptCache).
 */
import type {
  ServeShellRequestOptions,
  ServeShellRequestResult,
} from "../../flight.entry.js";
import { deserializeResult } from "../../../cache/segment-codec.js";
import {
  buildPrefetchKey,
  buildSourceKey,
  clearPrefetchCache,
  currentGeneration,
  paramsCandidateKeys,
  rememberParamsShape,
  storePrefetch,
  type DecodedPrefetch,
} from "../../../browser/prefetch/cache.js";
import type { SourcePage } from "../../../prefetch-source-scope.js";
import { prefetchStorageSlot } from "../../../browser/prefetch/fetch.js";
import { consumeStoredPrefetch } from "../../../browser/navigation-client.js";
import { isInterceptOnlyCache } from "../../../browser/intercept-utils.js";
import { isPlaceholder } from "../../../types/segments.js";
import type { RscPayload } from "../../../browser/types.js";
import type { ResolvedSegment } from "../../../types.js";
import {
  commitAnswer,
  historyBase,
  type Answer,
  type Screen,
} from "./browser-commit.js";
import { fetchUrlOf } from "./fetch-url.js";

export { commitAnswer, historyBase, type Answer, type Screen };

export const ORIGIN = "http://localhost";
const RANGO_STATE = "test-state";

export type Serve = (
  url: string,
  options: Omit<ServeShellRequestOptions, "cacheStore">,
) => Promise<ServeShellRequestResult>;

export async function answerOf(
  result: ServeShellRequestResult,
): Promise<Answer> {
  const { metadata } = await deserializeResult<{ metadata: Answer }>(
    result.flight!,
  );
  return metadata;
}

const pathOf = (url: URL): string => url.pathname + url.search;

/** The page an answer commits, as the router store holds it. */
export const pageOf = (answer: Answer): SourcePage => ({
  params: answer.params ?? {},
  routeName: answer.routeName,
});

/** A document load of `href`: every segment rendered. */
export async function loadScreen(serve: Serve, href: string): Promise<Screen> {
  const url = new URL(href, ORIGIN);
  const answer = await answerOf(
    await serve(pathOf(url), { partial: { from: pathOf(url) } }),
  );
  return {
    href: url.href,
    segments: answer.segments,
    matched: answer.matched,
    page: pageOf(answer),
  };
}

/** A response to the page on `from`. */
export interface Fetched {
  answer: Answer;
  /** `x-rsc-prefetch-scope`. */
  scope: string | null;
}

/**
 * The partial request for `to` sent from the page at `from` holding `ids`:
 * a `<Link>` prefetch, a click's own request, or the stale refetch holding
 * nothing that follows a commit with a missing segment. Undefined for a
 * prefetch of the page on screen, which prefetch/fetch.ts skips
 * (isSamePage).
 */
export async function request(
  serve: Serve,
  from: string,
  ids: readonly string[],
  to: string,
  kind: "prefetch" | "navigation" | "refetch",
): Promise<Fetched | undefined> {
  const source = new URL(from);
  const target = new URL(to, source);
  if (kind === "prefetch" && pathOf(target) === pathOf(source)) {
    return undefined;
  }
  const result = await serve(pathOf(target), {
    partial: {
      from: pathOf(source),
      segments: kind === "refetch" ? [] : ids,
      prefetch: kind === "prefetch",
      stale: kind === "refetch",
    },
  });
  return {
    answer: await answerOf(result),
    scope: result.response.headers.get("x-rsc-prefetch-scope"),
  };
}

/** The request `to` from the page on screen, holding what it holds. */
export const requestFrom = (
  serve: Serve,
  from: Screen,
  to: string,
  kind: "prefetch" | "navigation",
): Promise<Fetched | undefined> =>
  request(serve, from.href, from.matched, to, kind);

/** A new tab: an empty prefetch cache. */
export function resetPrefetchCache(): void {
  clearPrefetchCache(false);
}

/** Store a prefetch `from` made of `to` in the slot prefetch/fetch.ts picks. */
export function storePrefetchOf(
  from: Screen,
  to: string,
  fetched: Fetched,
): void {
  const fetchUrl = fetchUrlOf(to, from.href, from.matched);
  const slot = prefetchStorageSlot(
    false,
    fetched.scope,
    buildSourceKey(RANGO_STATE, from.href, fetchUrl),
    buildPrefetchKey(RANGO_STATE, fetchUrl),
    RANGO_STATE,
    fetchUrl,
  );
  const entry = (): DecodedPrefetch => ({
    payload: Promise.resolve({
      metadata: fetched.answer,
    } as unknown as RscPayload),
    streamComplete: Promise.resolve(),
    scope: slot.scope,
    paramsLabel: slot.paramsLabel,
    complete: true,
    respawn: entry,
  });
  storePrefetch(slot.key, entry(), currentGeneration());
  if (slot.paramsLabel !== undefined) {
    rememberParamsShape(fetchUrl, slot.paramsLabel);
  }
}

/**
 * The stored prefetch a click on `to` from `from` adopts, sending `ids`
 * (the page's, or a history entry's), as navigation-client.ts looks it up.
 */
export async function adoptPrefetch(
  from: Screen,
  to: string,
  ids: readonly string[] = from.matched,
): Promise<Answer | null> {
  const fetchUrl = fetchUrlOf(to, from.href, ids);
  const { entry } = consumeStoredPrefetch(
    true,
    buildSourceKey(RANGO_STATE, from.href, fetchUrl),
    paramsCandidateKeys(RANGO_STATE, fetchUrl, from.page ?? null),
    buildPrefetchKey(RANGO_STATE, fetchUrl),
  );
  if (!entry) return null;
  return (await entry.payload).metadata as unknown as Answer;
}

/**
 * A history entry a link may answer from (navigation-bridge.ts
 * hasUsableCache, isRestorable): segments, none a placeholder, an error or
 * an intercept's.
 */
export const usableEntry = (
  segments: ResolvedSegment[] | undefined,
): ResolvedSegment[] | undefined =>
  segments &&
  segments.length > 0 &&
  !segments.some((s) => isPlaceholder(s) || s.type === "error") &&
  !isInterceptOnlyCache(segments)
    ? segments
    : undefined;

/** How a click got its answer. */
export type Adoption = "prefetch" | "fetched" | "refetched";

/** A tab: the page on screen, its history, its prefetches and its clicks. */
export interface PrefetchBrowser {
  readonly screen: Screen;
  /** A document load of `href`. */
  load(href: string): Promise<Screen>;
  /** A `<Link>` prefetch of `to`: its `x-rsc-prefetch-scope`. */
  prefetch(to: string): Promise<string | null | undefined>;
  /**
   * A click on a link to `to`: sends the history entry's ids when the tab
   * visited it, and adopts a stored prefetch when one fits.
   */
  click(to: string): Promise<{ screen: Screen; adoption: Adoption }>;
}

export function createPrefetchBrowser(serve: Serve): PrefetchBrowser {
  resetPrefetchCache();
  let screen: Screen = { href: `${ORIGIN}/`, segments: [], matched: [] };
  const history = new Map<string, Screen>();
  const show = (next: Screen): Screen => {
    history.set(next.href, next);
    return (screen = next);
  };
  return {
    get screen() {
      return screen;
    },
    async load(href) {
      resetPrefetchCache();
      return show(await loadScreen(serve, href));
    },
    async prefetch(to) {
      const fetched = await requestFrom(serve, screen, to, "prefetch");
      if (!fetched) return undefined;
      storePrefetchOf(screen, to, fetched);
      return fetched.scope;
    },
    async click(to) {
      const href = new URL(to, screen.href).href;
      const entry = usableEntry(history.get(href)?.segments);
      const ids = entry ? entry.map((s) => s.id) : screen.matched;
      const adopted = await adoptPrefetch(screen, to, ids);
      const answer =
        adopted ??
        (await request(serve, screen.href, ids, to, "navigation"))!.answer;
      const base = entry ? historyBase(entry, screen.segments) : undefined;
      const segments = commitAnswer(answer, screen, base);
      if (segments === "missing") {
        const fresh = (await request(serve, screen.href, [], to, "refetch"))!;
        show({
          href,
          segments: fresh.answer.segments,
          matched: fresh.answer.matched,
          page: pageOf(fresh.answer),
        });
        return { screen, adoption: "refetched" };
      }
      show({ href, segments, matched: answer.matched, page: pageOf(answer) });
      return { screen, adoption: adopted ? "prefetch" : "fetched" };
    },
  };
}

const ELEMENT = Symbol.for("react.transitional.element");
const LAZY = Symbol.for("react.lazy");

const clientName = (node: any): string | undefined =>
  node?.$$typeof === LAZY && node._payload?.status === "resolved_module"
    ? `client:${node._payload.value[2]}`
    : undefined;

/**
 * A decoded node as plain data: host and client element types by name,
 * Flight promises and lazies resolved, functions by name.
 */
async function normalize(node: unknown): Promise<unknown> {
  if (node === null || node === undefined) return null;
  if (typeof node === "function") return `fn:${node.name}`;
  if (typeof node !== "object") return node;
  if (node instanceof URL) return node.href;
  if (Array.isArray(node)) return Promise.all(node.map(normalize));
  const record = node as Record<string | symbol, any>;
  if (record.$$typeof === LAZY) {
    return clientName(record) ?? normalize(await record._payload);
  }
  if (record.$$typeof === ELEMENT) {
    const type = record.type;
    return {
      type:
        typeof type === "string"
          ? type
          : (clientName(type) ?? (await normalize(type))),
      key: record.key,
      props: await normalize(record.props),
    };
  }
  if (typeof record.then === "function") return normalize(await record);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = await normalize(record[key]);
  }
  return out;
}

/** A normalized node as markup: `<section><h1>hero:audio</h1></section>`. */
function markup(node: unknown): string {
  if (node === null) return "";
  if (Array.isArray(node)) return node.map(markup).join("");
  if (typeof node !== "object") return String(node);
  const record = node as Record<string, unknown>;
  if ("type" in record && "props" in record && "key" in record) {
    const { children, ...props } = record.props as Record<string, unknown>;
    const attrs = Object.entries(props)
      .map(([name, value]) => ` ${name}=${JSON.stringify(value)}`)
      .join("");
    const key = record.key == null ? "" : ` key=${JSON.stringify(record.key)}`;
    return `<${record.type}${key}${attrs}>${markup(children ?? null)}</${record.type}>`;
  }
  return JSON.stringify(record);
}

const rendered = new WeakMap<ResolvedSegment, Promise<string>>();

/** What a segment renders, as one line: its id, type and output. */
export function renderedOf(segment: ResolvedSegment): Promise<string> {
  let line = rendered.get(segment);
  if (!line) {
    line = (async () => {
      const parts = [
        segment.id,
        segment.slot ? `${segment.type}(${segment.slot})` : segment.type,
        markup(await normalize(segment.component)),
      ];
      for (const [name, value] of [
        ["layout", segment.layout],
        ["loading", segment.loading],
        ["data", segment.loaderData],
        ["error", segment.error],
        ["notFound", segment.notFoundInfo],
      ] as const) {
        if (value != null)
          parts.push(`${name}=${markup(await normalize(value))}`);
      }
      return parts.join(" ");
    })();
    rendered.set(segment, line);
  }
  return line;
}

/** A tree, one line per segment. */
export function renderedTree(segments: ResolvedSegment[]): Promise<string[]> {
  return Promise.all(segments.map(renderedOf));
}
