/**
 * One `router.prerender()` warm request: build the synthetic visitor request,
 * dispatch it through the router's own handler, wait for everything it
 * scheduled, and read back what it wrote
 * (docs/design/prerender-every-route.md, "The synthetic request"). The handler
 * is an injected `fetch`, so unit tests drive this with a fake.
 */

import {
  awaitLaterMillisecond,
  raceDeadline,
  settleGrowing,
  type CollectingExecutionContext,
} from "../cache/background-task.js";
import { CAPTURE_QUEUE_WAIT_BUDGET_MS } from "../rsc/capture-queue.js";
import { SHELL_CAPTURE_TASK_HARD_CAP_MS } from "../rsc/shell-capture-constants.js";
import type { HandlerCacheConfig } from "../rsc/types.js";
import type { ExecutionContext } from "../types/request-scope.js";
import type { PrerenderResult, PrerenderWarmCaches } from "./on-demand.js";
import {
  createWarmRecord,
  markWarmRequest,
  type PrerenderWarmRecord,
} from "./warm-request.js";

/**
 * How long a warm waits for its response body and background work: a capture
 * that waited out the queue budget, then ran to its hard cap.
 */
export const WARM_SETTLE_BUDGET_MS: number =
  SHELL_CAPTURE_TASK_HARD_CAP_MS + CAPTURE_QUEUE_WAIT_BUDGET_MS;

export interface WarmRequestInput<TEnv> {
  /** The absolute URL a visitor requests. */
  url: URL;
  mode: PrerenderWarmRecord["mode"];
  /** The gated `createRouter({ cache })` config; the handler writes to its store. */
  cacheConfig: HandlerCacheConfig;
  env: TEnv;
  /** The context `cacheConfig` was resolved with. */
  ctx: CollectingExecutionContext;
  /** `router.fetch`. */
  fetch: (
    request: Request,
    input: { env: TEnv; ctx: ExecutionContext },
  ) => Promise<Response>;
  /** Tests shorten the wait. */
  settleBudgetMs?: number;
}

export interface WarmRequestOutcome {
  record: PrerenderWarmRecord;
  /** Absent when the handler threw before answering. */
  responseStatus?: number;
  /** The handler's throw, a body that failed mid-stream, or a wait that ran out. */
  error?: unknown;
}

/**
 * Dispatch one warm: a GET with `accept: text/html` and nothing else, so it
 * lands in the partition a header-less visitor lands in. The response is
 * drained and dropped: what it rendered reaches a visitor only through a
 * store.
 */
export async function runWarmRequest<TEnv>(
  input: WarmRequestInput<TEnv>,
): Promise<WarmRequestOutcome> {
  // `await updateTag(tag)` then a warm is the content-refresh pattern, and a
  // store refuses a shell whose capture started in the millisecond of an
  // invalidation of one of its tags (putShell's gate compares whole
  // milliseconds). Start in a later one, within the helper's bound.
  await awaitLaterMillisecond(Date.now());
  const record = createWarmRecord(input.mode, input.cacheConfig);
  const request = new Request(input.url, { headers: { accept: "text/html" } });
  markWarmRequest(request, record);
  const deadline = Date.now() + (input.settleBudgetMs ?? WARM_SETTLE_BUDGET_MS);

  let responseStatus: number | undefined;
  let error: unknown;
  try {
    const response = await input.fetch(request, {
      env: input.env,
      ctx: input.ctx,
    });
    responseStatus = response.status;
    // The render, and the tags and writes it records, finish with the body.
    const drained = await raceDeadline(drainBody(response), deadline);
    if (!drained.done) {
      error = new Error(
        `router.prerender(): the response for ${input.url.href} did not finish within the warm's wait`,
      );
    }
  } catch (err) {
    error = err ?? new Error("router.prerender(): the warm request failed");
  }
  await settleGrowing(input.ctx.tasks, deadline);
  return { record, responseStatus, error };
}

/**
 * Read the body to its end without keeping it. A non-200 is a failed warm
 * whatever its body says, so it is cancelled instead.
 */
async function drainBody(response: Response): Promise<void> {
  const { body } = response;
  if (!body) return;
  if (response.status !== 200) {
    await body.cancel().catch(() => {});
    return;
  }
  const reader = body.getReader();
  while (!(await reader.read()).done);
}

/** The per-cache detail a result carries. */
export function warmCaches(record: PrerenderWarmRecord): PrerenderWarmCaches {
  return {
    writes: { ...record.writes },
    ...(record.shell !== undefined ? { shell: record.shell } : {}),
    ...(record.refusal !== undefined ? { refusal: record.refusal } : {}),
    ...(record.document !== undefined ? { document: record.document } : {}),
  };
}

/**
 * A warm's status from what it recorded, first match wins. An identity
 * refusal comes ahead of the render failure it usually also causes (the guard
 * throws). `record.shell` is set only for a `ppr` route (shellServePlan).
 */
export function warmStatus(outcome: WarmRequestOutcome): WarmStatus {
  const { record, responseStatus, error } = outcome;
  if (record.identity !== undefined) return "skipped-personalized";
  if (
    error !== undefined ||
    responseStatus !== 200 ||
    record.renderErrors.length > 0
  ) {
    return "render-failed";
  }
  if (
    record.shell !== undefined &&
    record.shell !== "stored" &&
    record.shell !== "fresh"
  ) {
    return "shell-not-stored";
  }
  const { writes } = record;
  if (writes.record + writes.item + writes.response + writes.shell === 0) {
    return record.mode === "fill" ? "already-fresh" : "skipped-uncached";
  }
  return "warmed";
}

type WarmStatus =
  | Extract<PrerenderResult, { ok: true; path: "warm" }>["status"]
  | Extract<PrerenderResult, { ok: false }>["status"];

/** The `PrerenderResult` of a finished warm. */
export function composeWarmResult(
  outcome: WarmRequestOutcome,
  target: string,
  routeName: string,
): PrerenderResult {
  const status = warmStatus(outcome);
  const caches = warmCaches(outcome.record);
  if (status === "warmed" || status === "already-fresh") {
    // Both are answered only for a 200 (warmStatus).
    return {
      ok: true,
      path: "warm",
      status,
      target,
      routeName,
      responseStatus: outcome.responseStatus!,
      caches,
    };
  }
  const error =
    outcome.error ??
    (status === "render-failed" ? outcome.record.renderErrors[0] : undefined);
  return {
    ok: false,
    path: "warm",
    status,
    target,
    routeName,
    ...(outcome.responseStatus !== undefined
      ? { responseStatus: outcome.responseStatus }
      : {}),
    caches,
    ...(error !== undefined ? { error } : {}),
  };
}
