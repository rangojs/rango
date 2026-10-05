import { cookies, urls, type Handler } from "@rangojs/router";
import type { PrerenderResult } from "@rangojs/router/prerender";
import { WarmCounter } from "../components/WarmCounter.js";
// Type-only (erased: no runtime cycle with router.tsx).
import type { AppEnv } from "../router.js";

// router.prerender() warm fixture (e2e/prerender-warm.test.ts): routes that
// are not Prerender(..., { onDemand }), warmed through the request handler.
// Each test owns a ?probe=, and so its cache keys. A stamp carries the
// generation of the render that produced it; the suite moves a probe's
// generation on (/warm/__bump) to tell a stored render from a newer one.
const generations = new Map<string, number>();
const cachedRuns = new Map<string, number>();

function generationOf(probe: string): number {
  return generations.get(probe) ?? 1;
}

const WarmShellPage: Handler = (ctx) => {
  const probe = ctx.searchParams.get("probe") ?? "";
  return (
    <main data-testid="warm-shell-page">
      <p data-testid="warm-stamp">{`shell-${probe}@g${generationOf(probe)}`}</p>
      <WarmCounter />
    </main>
  );
};

// The run number tells a record HIT (the handler did not run) from a render.
const WarmCachedPage: Handler = (ctx) => {
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
const WarmPersonalPage: Handler = () => {
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
// origin of this request. The router is imported lazily: this module has no
// import cycle with router.tsx.
const WarmTrigger: Handler = async (ctx) => {
  const { router } = await import("../router.js");
  const prerender = router.prerender({ env: ctx.env as AppEnv });
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

export const prerenderWarmPatterns = urls(({ path, cache }) => [
  path("/warm/shell", WarmShellPage, {
    name: "warmShell",
    ppr: { ttl: 300, swr: 120 },
  }),
  cache({ ttl: 300 }, () => [
    path("/warm/cached", WarmCachedPage, { name: "warmCached" }),
  ]),
  path("/warm/personal", WarmPersonalPage, {
    name: "warmPersonal",
    ppr: { ttl: 300, swr: 120 },
  }),
  path("/warm/__trigger", WarmTrigger, { name: "warmTrigger" }),
  path.json(
    "/warm/__bump",
    (ctx): { generation: number } => {
      const probe = ctx.searchParams.get("probe") ?? "";
      const next = generationOf(probe) + 1;
      generations.set(probe, next);
      return { generation: next };
    },
    { name: "warmBump" },
  ),
]);
