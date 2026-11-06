/**
 * Serve one navigation as every response shape the router answers it with,
 * so a test can check a property of all of them at once (most often that no
 * internal segment field reaches the client).
 *
 * A field set on a segment can travel in more containers than the one a fix
 * reads: the segment list, an intercept's slot, a stored record and the
 * replay built from it. A check run on the document and a plain partial only
 * misses the slot and the stored paths, which is where such leaks showed up.
 * Each shape here goes through `serveShellRequest`, the same entry the
 * production handler uses, so a stored shape is a real MISS then HIT on one
 * store, and a `ppr` route's HIT is its replay.
 */
import { expect } from "vitest";
import {
  serveShellRequest,
  type ServeShellRequestOptions,
  type ServeShellRequestResult,
} from "../../flight.entry.js";
import type { Rango } from "../../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../../cache/index.js";
import { answerOf } from "./prefetch-browser.js";

/** One navigation to serve in every shape. */
export interface NavigationPlan {
  /** The page the browser is on. */
  from: string;
  /** The page it navigates to. */
  to: string;
  /**
   * Treat `to` as an intercept opened from `from` (sent with `from` as the
   * intercept source), then move the open intercept to `next`.
   */
  intercept?: { next: string };
  /** Environment bindings for every request. */
  env?: unknown;
}

/** One served response. */
export interface ServedShape {
  /** What was served, e.g. `"partial HIT"` or `"intercept moved MISS"`. */
  name: string;
  result: ServeShellRequestResult;
}

type PartialRequest = Exclude<
  ServeShellRequestOptions["partial"],
  true | undefined
>;

const matchedOf = async (result: ServeShellRequestResult): Promise<string[]> =>
  result.flight ? (await answerOf(result)).matched : [];

/**
 * Serves `plan` as: the document at `from` and at `to` (MISS, then HIT on one
 * store); the partial navigation `from` to `to` (MISS, then HIT on a fresh
 * store); and, with `intercept`, the intercept opened at `to` and then moved
 * to `next` (each MISS, then HIT). A route with `ppr` replays on its HIT.
 */
export async function serveEveryShape(
  router: Rango<any, any>,
  plan: NavigationPlan,
): Promise<ServedShape[]> {
  const shapes: ServedShape[] = [];
  const twice = async (
    name: string,
    url: string,
    partial?: PartialRequest,
  ): Promise<ServeShellRequestResult> => {
    const options = {
      cacheStore: new MemorySegmentCacheStore(),
      env: plan.env,
      partial,
    };
    const miss = await serveShellRequest(router, url, options);
    shapes.push({ name: `${name} MISS`, result: miss });
    const hit = await serveShellRequest(router, url, options);
    shapes.push({ name: `${name} HIT`, result: hit });
    return miss;
  };

  const fromPage = await twice("document from", plan.from);
  await twice("document to", plan.to);
  const fromSegments = await matchedOf(fromPage);
  await twice("partial", plan.to, { from: plan.from, segments: fromSegments });
  if (plan.intercept) {
    const opened = await twice("intercept opened", plan.to, {
      from: plan.from,
      interceptSource: plan.from,
      segments: fromSegments,
    });
    await twice("intercept moved", plan.intercept.next, {
      from: plan.to,
      interceptSource: plan.from,
      segments: await matchedOf(opened),
    });
  }
  return shapes;
}

/**
 * The `_`-prefixed object keys in a Flight or HTML text: internal segment
 * fields such as `_handlerRan`, which the client must never receive.
 */
export function internalFieldsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/"(_[A-Za-z][A-Za-z0-9]*)":/g)) {
    found.add(match[1]!);
  }
  return [...found].sort();
}

/**
 * Fails, naming each shape and field, when any served Flight payload, prelude
 * or body carries an internal field.
 */
export function expectNoInternalFields(shapes: readonly ServedShape[]): void {
  const leaks: Record<string, string[]> = {};
  for (const { name, result } of shapes) {
    const fields = internalFieldsIn(
      [result.flight, result.prelude, result.body].filter(Boolean).join("\n"),
    );
    if (fields.length > 0) leaks[name] = fields;
  }
  expect(
    leaks,
    `internal fields reached the client: ${JSON.stringify(leaks)}`,
  ).toEqual({});
}
