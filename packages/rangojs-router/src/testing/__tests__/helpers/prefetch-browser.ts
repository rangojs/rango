/**
 * One browser tab over serveShellRequest, for the source-independence tests
 * (#1331): the page on screen, its prefetches and its clicks, through the
 * browser's own modules.
 *
 * - A prefetch is sent from the page with its segment ids, as
 *   browser/prefetch/fetch.ts sends it, and stored under the key that
 *   module picks from `x-rsc-prefetch-scope` (buildSourceKey or
 *   buildPrefetchKey) in the real prefetch cache (browser/prefetch/cache.ts).
 * - A click looks the target up as browser/navigation-client.ts does (the
 *   source key, then the shared key) and applies what it adopted, or its own
 *   request's answer, as browser/partial-update.ts does: an empty diff keeps
 *   the screen (its treeless commit); otherwise reconcileSegments with the
 *   page's segments, and a refetch holding nothing when a matched id is
 *   missing.
 *
 * Not modelled: the in-flight adoption path, the clientUrls() optimistic
 * frame a click paints before the answer, and the handle store's merge.
 */
import type {
  ServeShellRequestOptions,
  ServeShellRequestResult,
} from "../../flight.entry.js";
import { deserializeResult } from "../../../cache/segment-codec.js";
import { reconcileSegments } from "../../../browser/segment-reconciler.js";
import {
  buildPrefetchKey,
  buildSourceKey,
  clearPrefetchCache,
  consumePrefetch,
  currentGeneration,
  storePrefetch,
  type DecodedPrefetch,
} from "../../../browser/prefetch/cache.js";
import { writePartialParams } from "../../../browser/wire-protocol.js";
import type { RscPayload } from "../../../browser/types.js";
import type { ResolvedSegment } from "../../../types.js";

export const ORIGIN = "http://localhost";
const RANGO_STATE = "test-state";

export type Serve = (
  url: string,
  options: Omit<ServeShellRequestOptions, "cacheStore">,
) => Promise<ServeShellRequestResult>;

/** A partial response's metadata, as the browser decodes it. */
export interface Answer {
  segments: ResolvedSegment[];
  matched: string[];
  diff: string[];
}

/** What a tab shows: the URL and the segments its tree is built from. */
export interface Screen {
  href: string;
  segments: ResolvedSegment[];
  matched: string[];
}

export async function answerOf(
  result: ServeShellRequestResult,
): Promise<Answer> {
  const { metadata } = await deserializeResult<{ metadata: Answer }>(
    result.flight!,
  );
  return metadata;
}

const pathOf = (url: URL): string => url.pathname + url.search;

/** The request URL navigation-client.ts builds: the keys derive from it. */
const fetchUrlOf = (to: string, from: Screen): URL =>
  writePartialParams(new URL(to, from.href), {
    segmentIds: from.matched,
    emptySegments: "send",
  });

/** A document load of `href`: every segment rendered. */
export async function loadScreen(serve: Serve, href: string): Promise<Screen> {
  const url = new URL(href, ORIGIN);
  const answer = await answerOf(
    await serve(pathOf(url), { partial: { from: pathOf(url) } }),
  );
  return { href: url.href, segments: answer.segments, matched: answer.matched };
}

/** A response to the page on `from`. */
export interface Fetched {
  answer: Answer;
  /** `x-rsc-prefetch-scope`. */
  scope: string | null;
}

/**
 * The partial request for `to` sent from `from` with its segment ids: a
 * `<Link>` prefetch, or a click's own request. Undefined for a prefetch of
 * the page on screen, which prefetch/fetch.ts skips (isSamePage).
 */
export async function requestFrom(
  serve: Serve,
  from: Screen,
  to: string,
  kind: "prefetch" | "navigation",
): Promise<Fetched | undefined> {
  const source = new URL(from.href);
  const target = new URL(to, source);
  if (kind === "prefetch" && pathOf(target) === pathOf(source)) {
    return undefined;
  }
  const result = await serve(pathOf(target), {
    partial: {
      from: pathOf(source),
      segments: from.matched,
      prefetch: kind === "prefetch",
    },
  });
  return {
    answer: await answerOf(result),
    scope: result.response.headers.get("x-rsc-prefetch-scope"),
  };
}

/** A new tab: an empty prefetch cache. */
export function resetPrefetchCache(): void {
  clearPrefetchCache(false);
}

/**
 * Store a prefetch `from` made of `to` as prefetch/fetch.ts does: under the
 * source key when the response says `x-rsc-prefetch-scope: source`, else
 * under the key every source page shares.
 */
export function storePrefetchOf(
  from: Screen,
  to: string,
  fetched: Fetched,
): void {
  const fetchUrl = fetchUrlOf(to, from);
  const scope = fetched.scope === "source" ? "source" : "wildcard";
  const key =
    scope === "source"
      ? buildSourceKey(RANGO_STATE, from.href, fetchUrl)
      : buildPrefetchKey(RANGO_STATE, fetchUrl);
  const entry = (): DecodedPrefetch => ({
    payload: Promise.resolve({
      metadata: fetched.answer,
    } as unknown as RscPayload),
    streamComplete: Promise.resolve(),
    scope,
    complete: true,
    respawn: entry,
  });
  storePrefetch(key, entry(), currentGeneration());
}

/**
 * The stored prefetch a click on `to` from `from` adopts, looked up as
 * navigation-client.ts does: the source key, then the shared one.
 */
export async function adoptPrefetch(
  from: Screen,
  to: string,
): Promise<Answer | null> {
  const fetchUrl = fetchUrlOf(to, from);
  const entry =
    consumePrefetch(buildSourceKey(RANGO_STATE, from.href, fetchUrl)) ??
    consumePrefetch(buildPrefetchKey(RANGO_STATE, fetchUrl));
  if (!entry) return null;
  return (await entry.payload).metadata as unknown as Answer;
}

/**
 * What partial-update.ts builds the tree from once `answer` lands on
 * `from`: an empty diff keeps the screen (its treeless commit); otherwise
 * the reconciled segments, or "missing" when a matched id is in neither the
 * answer nor the page (the browser then refetches holding nothing).
 */
export function applyAnswer(
  answer: Answer,
  from: Screen,
): ResolvedSegment[] | "missing" {
  if (answer.diff.length === 0) return from.segments;
  const { segments } = reconcileSegments({
    actor: "navigation",
    matched: answer.matched,
    diff: answer.diff,
    serverSegments: answer.segments,
    cachedSegments: from.segments,
    insertMissingDiff: true,
  });
  const ids = new Set(segments.map((s) => s.id));
  return answer.matched.every((id) => ids.has(id)) ? segments : "missing";
}

/** How a click got its answer. */
export type Adoption = "prefetch" | "fetched" | "refetched";

/** A tab: the page on screen, its prefetches and its clicks. */
export interface PrefetchBrowser {
  readonly screen: Screen;
  /** A document load of `href`. */
  load(href: string): Promise<Screen>;
  /** A `<Link>` prefetch of `to`: its `x-rsc-prefetch-scope`. */
  prefetch(to: string): Promise<string | null | undefined>;
  /** A click on a link to `to`: adopts a stored prefetch when one fits. */
  click(to: string): Promise<{ screen: Screen; adoption: Adoption }>;
}

export function createPrefetchBrowser(serve: Serve): PrefetchBrowser {
  resetPrefetchCache();
  let screen: Screen = { href: `${ORIGIN}/`, segments: [], matched: [] };
  return {
    get screen() {
      return screen;
    },
    async load(href) {
      resetPrefetchCache();
      return (screen = await loadScreen(serve, href));
    },
    async prefetch(to) {
      const fetched = await requestFrom(serve, screen, to, "prefetch");
      if (!fetched) return undefined;
      storePrefetchOf(screen, to, fetched);
      return fetched.scope;
    },
    async click(to) {
      const href = new URL(to, screen.href).href;
      const adopted = await adoptPrefetch(screen, to);
      const answer =
        adopted ?? (await requestFrom(serve, screen, to, "navigation"))!.answer;
      const segments = applyAnswer(answer, screen);
      if (segments === "missing") {
        const empty: Screen = { ...screen, segments: [], matched: [] };
        const fresh = (await requestFrom(serve, empty, to, "navigation"))!;
        screen = {
          href,
          segments: fresh.answer.segments,
          matched: fresh.answer.matched,
        };
        return { screen, adoption: "refetched" };
      }
      screen = { href, segments, matched: answer.matched };
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
    return `<${record.type}${attrs}>${markup(children ?? null)}</${record.type}>`;
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
