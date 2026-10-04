// Type-only pin (runs under `pnpm run typecheck`): the target `onRevalidate`
// receives feeds `router.prerender()` on a router with named routes, with no
// cast, while a hand-written wrong route name or params stays a type error.
import type { PrerenderTargetObject } from "@rangojs/router/prerender";
import type { router } from "./router.js";
import type { AppBindings } from "./env.js";

declare const prerender: typeof router.prerender;
declare const env: AppBindings;
declare const queued: string;

export async function pinPrerenderTargetTypes(): Promise<void> {
  await prerender({ route: "guides.detail", params: { slug: "a" } }, { env });

  const target = JSON.parse(queued) as PrerenderTargetObject;
  await prerender(target, { env });
  await prerender.many([target], { env });

  // @ts-expect-error unknown route name
  await prerender({ route: "guides.nope", params: { slug: "a" } }, { env });
  // @ts-expect-error params do not match the route
  await prerender({ route: "guides.detail", params: { id: "a" } }, { env });
  // @ts-expect-error an unbranded { route, params } is not an onRevalidate target
  await prerender({ route: "x" as string, params: {} }, { env });
}
