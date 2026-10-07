import { cookies, type Handler } from "@rangojs/router";
import type { PrerenderResult } from "@rangojs/router/prerender";
import { WarmCounter } from "../components/WarmCounter.js";

// router.prerender() warm fixture (e2e/prerender-warm.test.ts): routes that
// are not Prerender(..., { onDemand }), warmed through the request handler
// into CFCacheStore over KV. Each test owns a ?probe=, and so its cache keys.
// A stamp carries the generation of the render that produced it; the suite
// moves a probe's generation on (/__test/warm-bump) to tell a stored render
// from a newer one.
const generations = new Map<string, number>();
const cachedRuns = new Map<string, number>();

function generationOf(probe: string): number {
  return generations.get(probe) ?? 1;
}

export function bumpWarmGeneration(probe: string): number {
  const next = generationOf(probe) + 1;
  generations.set(probe, next);
  return next;
}

export const WarmShellPage: Handler = (ctx) => {
  const probe = ctx.searchParams.get("probe") ?? "";
  return (
    <main data-testid="warm-shell-page">
      <p data-testid="warm-stamp">{`shell-${probe}@g${generationOf(probe)}`}</p>
      <WarmCounter />
    </main>
  );
};

// The run number tells a record HIT (the handler did not run) from a render.
export const WarmCachedPage: Handler = (ctx) => {
  const probe = ctx.searchParams.get("probe") ?? "";
  const run = (cachedRuns.get(probe) ?? 0) + 1;
  cachedRuns.set(probe, run);
  return (
    <main data-testid="warm-cached-page">
      <p data-testid="warm-stamp">
        {`cached-${probe}@g${generationOf(probe)}#r${run}`}
      </p>
    </main>
  );
};

// Reads the visitor's cookie in the handler: a shell capture refuses it.
export const WarmPersonalPage: Handler = () => {
  const session = cookies().get("session")?.value ?? "anonymous";
  return (
    <main data-testid="warm-personal-page">
      <p data-testid="warm-stamp">{`personal-${session}`}</p>
    </main>
  );
};

// Error instances do not survive Response.json: flatten to the message.
function flattenResult(result: PrerenderResult): unknown {
  return !result.ok && result.error instanceof Error
    ? { ...result, error: result.error.message }
    : result;
}

// GET ?target=<path>[&target=<path>...][&onlyIfStale=1]: one target answers
// its PrerenderResult, several answer the .many() results. The targets are
// paths and the binding has no `origin`, so a warm requests them on the
// origin of this request. Typed as Handler so the lazy import does not make
// this module's type depend on the router built from the urlpatterns.
export const WarmTrigger: Handler = async (ctx) => {
  const { router } = await import("../router.js");
  // localStore=1: the warm gate builds the app store from this env, and
  // without KV a CFCacheStore declares scope "local" (router.tsx). Requests
  // keep the real env, so the app store itself is unchanged.
  const env =
    ctx.searchParams.get("localStore") === "1"
      ? { ...ctx.env, KV: undefined as unknown as KVNamespace }
      : ctx.env;
  const prerender = router.prerender({
    env,
    ctx: ctx.executionContext,
  });
  const targets = ctx.searchParams.getAll("target");
  const options =
    ctx.searchParams.get("onlyIfStale") === "1"
      ? { onlyIfStale: true }
      : undefined;
  if (targets.length === 1) {
    return Response.json(flattenResult(await prerender(targets[0]!, options)));
  }
  const results = await prerender.many(targets, options);
  return Response.json(results.map(flattenResult));
};
