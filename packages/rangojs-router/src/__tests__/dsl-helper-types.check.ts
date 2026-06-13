/**
 * Type-level tests for the cache()/transition() DSL helper surfaces.
 * Verified by tsc --noEmit.
 *
 * Pins two type-vs-runtime drifts surfaced by the review:
 *   - M7: transition() must accept all four runtime-supported forms.
 *   - M14: cache() condition/key/tags callbacks must see a typed ctx.env (TEnv),
 *          not unknown.
 */

import type { RouteHelpers } from "../route-definition/helpers-types.js";
import type { PathHelpers } from "../urls/path-helper-types.js";

// --- M7: transition() four-form contract ---
//
// The runtime (dsl-helpers.ts transition()) resolves four forms:
//   transition(), transition(config), transition(children), transition(config, children)
// The exported RouteHelpers["transition"] type previously declared only the two
// config forms, so transition() failed with TS2554 and transition(children) with
// TS2559 despite working at runtime.

declare const rh: RouteHelpers<any, any>;
rh.transition();
rh.transition(() => []);
rh.transition({});
rh.transition({ enter: "fade-in", exit: "fade-out" }, () => []);

// The PathHelpers surface handed to urls<TEnv>() must keep all four forms too.
declare const ph: PathHelpers<{ REGION: string }>;
ph.transition();
ph.transition(() => []);
ph.transition({});
ph.transition({}, () => []);

// --- M14: cache() callbacks receive RequestContext<TEnv> (ctx.env typed) ---
//
// PathHelpers["cache"] previously used bare PartialCacheOptions, collapsing
// ctx.env to unknown so the documented `${ctx.env.REGION}` pattern failed with
// TS18046. With PartialCacheOptions<TEnv> the env is typed.

ph.cache({
  key: (ctx) => `${ctx.env.REGION}:product`,
  condition: (ctx) => ctx.env.REGION !== "blocked",
});
