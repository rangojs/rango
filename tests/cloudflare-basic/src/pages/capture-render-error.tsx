import { Suspense } from "react";
import type { HandlerContext } from "@rangojs/router";

// Issue #915: whole-response captures must not store a render whose component
// threw after the 200 committed. Reviews is an async server component inside
// a Suspense boundary that throws on the first `failFor` renders per ?run=
// value, then renders. The throw lands in the Flight stream as an error row
// and in the HTML as an errored boundary; the status stays 200.
const renders = new Map<string, number>();

async function Reviews({ run, failFor }: { run: string; failFor: number }) {
  await Promise.resolve();
  const count = (renders.get(run) ?? 0) + 1;
  renders.set(run, count);
  if (count <= failFor) throw new Error("reviews upstream down");
  return <p data-testid="capture-render-error-ok">reviews</p>;
}

function Page({ run, failFor }: { run: string; failFor: number }) {
  return (
    <main data-testid="capture-render-error-page">
      <h1>Capture render error</h1>
      <Suspense fallback={<p>loading reviews</p>}>
        <Reviews run={run} failFor={failFor} />
      </Suspense>
    </main>
  );
}

/**
 * Document-cached (s-maxage). The first render per run throws: the document
 * cache must not store it, and the next request renders and stores.
 */
export function DocumentCacheRenderErrorPage(ctx: HandlerContext) {
  ctx.headers.set("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  return <Page run={ctx.searchParams.get("run") ?? ""} failFor={1} />;
}

/**
 * PPR route. The first three renders per run throw: the foreground MISS, the
 * capture's Flight render, and the capture's doc-record encode. The capture
 * must not store the errored shell; a later clean capture stores.
 */
export function PprRenderErrorPage(ctx: HandlerContext) {
  return <Page run={ctx.searchParams.get("run") ?? ""} failFor={3} />;
}

// Handler runs per ?run= for RouteCacheRenderErrorPage. A cache HIT skips the
// handler, so the rendered count holds.
const routeCacheRuns = new Map<string, number>();

async function RouteCacheReviews({ fail }: { fail: boolean }) {
  await Promise.resolve();
  if (fail) throw new Error("reviews upstream down");
  return <p data-testid="capture-render-error-ok">reviews</p>;
}

/**
 * Under cache() (issue #909). The first handler run per ?run= passes
 * fail=true, so Reviews throws in the live render and in the cache write's
 * re-render; later runs render. The route cache must not store the first run.
 */
export function RouteCacheRenderErrorPage(ctx: HandlerContext) {
  const run = ctx.searchParams.get("run") ?? "";
  const handlerRun = (routeCacheRuns.get(run) ?? 0) + 1;
  routeCacheRuns.set(run, handlerRun);
  return (
    <main data-testid="capture-render-error-page">
      <p data-testid="route-cache-handler-run">{handlerRun}</p>
      <Suspense fallback={<p>loading reviews</p>}>
        <RouteCacheReviews fail={handlerRun === 1} />
      </Suspense>
    </main>
  );
}
