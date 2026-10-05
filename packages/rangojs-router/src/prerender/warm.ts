/**
 * One `router.prerender()` warm request: build the synthetic visitor request,
 * dispatch it through the router's own handler, wait for everything it
 * scheduled, and read back what it wrote
 * (docs/design/prerender-every-route.md, "The synthetic request"). The handler
 * is an injected `fetch`, so unit tests drive this with a fake.
 */

import { raceDeadline, settleGrowing } from "../cache/background-task.js";
import { CAPTURE_QUEUE_WAIT_BUDGET_MS } from "../rsc/capture-queue.js";
import { SHELL_CAPTURE_TASK_HARD_CAP_MS } from "../rsc/shell-capture-constants.js";
import type { HandlerCacheConfig } from "../rsc/types.js";
import type { ExecutionContext } from "../types/request-scope.js";
import type { PrerenderWarmCaches } from "./on-demand.js";
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

/** An ExecutionContext that keeps every promise handed to `waitUntil`. */
export interface CollectingExecutionContext extends ExecutionContext {
  readonly tasks: Promise<unknown>[];
}

/**
 * Wrap the caller's ExecutionContext (or none) so the warm can wait for the
 * request's background work: the deferred cache writes, the shell capture, a
 * store's own writes. Every other member reads through to `inner`, bound to
 * it (workerd's methods reject a foreign `this`).
 */
export function createCollectingExecutionContext(
  inner?: ExecutionContext,
): CollectingExecutionContext {
  const tasks: Promise<unknown>[] = [];
  const own: CollectingExecutionContext = {
    tasks,
    waitUntil(promise) {
      const task = Promise.resolve(promise);
      // The list only waits; the host (or the log below) owns the failure.
      tasks.push(task.catch(() => {}));
      if (inner) inner.waitUntil(task);
      else {
        task.catch((error) =>
          console.error("[waitUntil] Background task failed:", error),
        );
      }
    },
    passThroughOnException() {},
  };
  if (!inner) return own;
  return new Proxy(own, {
    get(target, prop) {
      if (prop in target) return target[prop as keyof typeof target];
      const value = (inner as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof value === "function" ? value.bind(inner) : value;
    },
  });
}

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
  // milliseconds). Start in a later one.
  const called = Date.now();
  while (Date.now() === called) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
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
    const drained = await raceDeadline(
      response.arrayBuffer().then(() => undefined),
      deadline,
    );
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

/** The per-cache detail a result carries. */
export function warmCaches(record: PrerenderWarmRecord): PrerenderWarmCaches {
  return {
    writes: { ...record.writes },
    ...(record.shell !== undefined ? { shell: record.shell } : {}),
    ...(record.refusal !== undefined ? { refusal: record.refusal } : {}),
    ...(record.document !== undefined ? { document: record.document } : {}),
  };
}

/** The status of a warm, first match wins. */
export type WarmStatus =
  | "warmed"
  | "already-fresh"
  | "skipped-personalized"
  | "render-failed"
  | "shell-not-stored"
  | "skipped-uncached";

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
    (record.renderErrors?.length ?? 0) > 0
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
