import { createLoader, redirect } from "@rangojs/router";
import { CuFlash } from "../location-states.js";
import { getClientUrlsActionCount } from "./client-urls-action.store.js";

export const ClientUrlsItemLoader = createLoader(async (ctx) => {
  await new Promise((resolve) => setTimeout(resolve, 700));
  return `client-urls-item:${ctx.params.itemId}`;
});

export const ClientUrlsCounterLoader = createLoader(async () => {
  return `count:${getClientUrlsActionCount()}`;
});

/**
 * Distinct $$id reading the SAME counter — its client-run revalidate() skips
 * action revalidation, so after an action this value diverges from
 * ClientUrlsCounterLoader in the same commit (per-loader decisions, not a
 * route-level batch).
 */
export const ClientUrlsSessionLoader = createLoader(async () => {
  return `session:${getClientUrlsActionCount()}`;
});

/**
 * Loader-thrown redirect() WITH state. The await forces settlement during
 * Flight serialization (the streaming lane — metadata already flushed), so
 * the state cannot ride payload.metadata.locationState: it must travel with
 * the redirect itself and merge at the target, action-style.
 */
export const ClientUrlsLegacyRedirectLoader = createLoader(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  throw redirect("/client-urls-e2e/state?from=legacy", {
    state: CuFlash({ text: "cu-loader-flash" }),
  });
});

let pprSeq = 0;

/**
 * Live hole under the group's frozen ppr shell: delayed so the stored
 * prelude clearly beats it on a HIT; monotonic so per-request liveness is
 * assertable while the shell above it stays frozen.
 */
export const ClientUrlsPprLoader = createLoader(async () => {
  await new Promise((resolve) => setTimeout(resolve, 250));
  pprSeq += 1;
  return { seq: pprSeq };
});

let pprBakedSeq = 0;

/**
 * stream:"navigation" loader on the group's ppr route: executes at capture
 * and its settled return is SHELL material — the group analog of the
 * server-route bake pin. Monotonic so frozen-ness is observable (the seq
 * must NOT advance across HITs).
 */
export const ClientUrlsPprBakedLoader = createLoader(async () => {
  pprBakedSeq += 1;
  return { label: `group-baked-${pprBakedSeq}` };
});

let stampCounter = 0;

/**
 * Fetchable loader for the group hooks probe: useFetchLoader() addresses it
 * by id through the loader endpoint — a lane with no route/group mechanics
 * at all, so it works inside clientUrls exactly as anywhere else. The
 * monotonic counter makes consecutive load() calls observably distinct.
 */
export const ClientUrlsStampLoader = createLoader(async () => {
  stampCounter += 1;
  return `stamp:${stampCounter}`;
}, true);

let pulseCounter = 0;

/**
 * Route-owned loader for the useRefreshLoaders probe: reads tag it with
 * refreshGroup and refresh("probe") re-runs it. FETCHABLE is required — the
 * refresh lane is the loader fetch lane (LoaderStore refetch = load()), in
 * and out of groups alike. Monotonic so a refresh is observable as a CHANGE
 * (absolute values are shared across requests).
 */
export const ClientUrlsPulseLoader = createLoader(async () => {
  pulseCounter += 1;
  return `pulse:${pulseCounter}`;
}, true);
