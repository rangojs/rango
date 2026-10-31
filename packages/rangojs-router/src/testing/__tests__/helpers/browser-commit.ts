/**
 * The browser's commit of a partial answer, as plain data, for the
 * source-independence tests (#1331).
 *
 * The commit and the history-entry merge live in hook-locked files
 * (browser/partial-update.ts fetchPartialUpdate, browser/navigation-bridge.ts
 * navigate; tools/hook-lock.json), so they are not exported from there. This
 * module restates them over the same production helpers (reconcileSegments,
 * idsAboveBoundary, isPlaceholder), and
 * __tests__/prefetch-browser-commit.test.tsx pins it to production: it runs
 * the real navigation bridge and partial updater on the same inputs and
 * compares what each renders, the ids each next request sends, and when each
 * refetches.
 */
import {
  idsAboveBoundary,
  reconcileSegments,
} from "../../../browser/segment-reconciler.js";
import { isPlaceholder } from "../../../types/segments.js";
import type { ResolvedSegment } from "../../../types.js";
import type { SourcePage } from "../../../prefetch-source-scope.js";

/** A partial response's metadata, as the browser decodes it. */
export interface Answer {
  segments: ResolvedSegment[];
  matched: string[];
  diff: string[];
  /** The page's params, which the router store commits with it. */
  params?: Record<string, string>;
  /** The page's public route name. */
  routeName?: string;
}

/** What a tab shows: the URL and the segments its tree is built from. */
export interface Screen {
  href: string;
  segments: ResolvedSegment[];
  /** The ids the page's next request sends. */
  matched: string[];
  /**
   * The params and route name the router store committed with the page
   * (navigation-store-handle.ts getCommittedPage): the group a params-scoped
   * prefetch is looked up for. None: no params-scoped lookup.
   */
  page?: SourcePage;
}

/**
 * The base a link to a page the history cache holds reconciles against
 * (navigation-bridge.ts navigate): the entry's segments, with the page on
 * screen's copy of every id both hold, unless that copy is a placeholder.
 */
export function historyBase(
  entry: readonly ResolvedSegment[],
  onScreen: readonly ResolvedSegment[],
): ResolvedSegment[] {
  const source = new Map(onScreen.map((s) => [s.id, s]));
  return entry.map((target) => {
    const copy = source.get(target.id);
    return !copy || isPlaceholder(copy) ? target : copy;
  });
}

/**
 * What a navigation's commit renders once `answer` lands on `onScreen`
 * (partial-update.ts fetchPartialUpdate):
 * - an empty diff: from a history entry, the matched ids taken from its base;
 *   otherwise the tree stays as it is (the treeless commit);
 * - otherwise the answer reconciled against the entry's base or the page on
 *   screen;
 * - "missing" when an id the answer holds above its boundary, not a
 *   placeholder, is in neither (the browser then refetches holding nothing,
 *   as a stale request).
 */
export function commitAnswer(
  answer: Answer,
  onScreen: Screen,
  entryBase?: readonly ResolvedSegment[],
): ResolvedSegment[] | "missing" {
  if (answer.diff.length === 0) {
    if (!entryBase) return onScreen.segments;
    const byId = new Map(entryBase.map((s) => [s.id, s]));
    return answer.matched
      .map((id) => byId.get(id))
      .filter((s): s is ResolvedSegment => s !== undefined);
  }
  const { segments } = reconcileSegments({
    actor: "navigation",
    matched: answer.matched,
    diff: answer.diff,
    serverSegments: answer.segments,
    cachedSegments: [...(entryBase ?? onScreen.segments)],
    insertMissingDiff: true,
  });
  const placeholders = new Set(
    answer.segments.filter(isPlaceholder).map((s) => s.id),
  );
  const held = idsAboveBoundary(answer.matched, undefined).filter(
    (id) => !placeholders.has(id),
  );
  const ids = new Set(segments.map((s) => s.id));
  return held.every((id) => ids.has(id)) ? segments : "missing";
}
