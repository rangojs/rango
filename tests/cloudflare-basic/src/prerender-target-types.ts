// Type-only pin (runs under `pnpm run typecheck`): the target `onRevalidate`
// receives feeds the `router.prerender({ env })` runner on a router with named routes, with no
// cast, while a hand-written wrong route name or params stays a type error.
import type {
  PrerenderConfig,
  PrerenderTargetObject,
} from "@rangojs/router/prerender";
import type { router } from "./router.js";
import type { AppBindings } from "./env.js";

declare const bind: typeof router.prerender;
declare const env: AppBindings;
declare const queued: string;

export async function pinPrerenderTargetTypes(): Promise<void> {
  const prerender = bind({ env });
  await prerender({ route: "guides.detail", params: { slug: "a" } });

  const target = JSON.parse(queued) as PrerenderTargetObject;
  await prerender(target);
  await prerender.many([target]);

  // @ts-expect-error unknown route name
  await prerender({ route: "guides.nope", params: { slug: "a" } });
  // @ts-expect-error params do not match the route
  await prerender({ route: "guides.detail", params: { id: "a" } });
  // @ts-expect-error an unbranded { route, params } is not an onRevalidate target
  await prerender({ route: "x" as string, params: {} });

  // prerender.remove() and its batch form take the same targets.
  await prerender.remove({ route: "guides.detail", params: { slug: "a" } });
  await prerender.remove(target, { throwOnError: true });
  await prerender.remove.many(["/guides/a", target], { concurrency: 2 });
  // @ts-expect-error unknown route name
  await prerender.remove({ route: "guides.nope", params: { slug: "a" } });
  // @ts-expect-error onlyIfStale is a refresh option: a removal renders nothing
  await prerender.remove("/guides/a", { onlyIfStale: true });
  // @ts-expect-error nor is it one of the batch form's
  await prerender.remove.many(["/guides/a"], { onlyIfStale: true });
}

// The documented one-liner: onRevalidate's env and ctx bind the runner, and
// onlyIfStale makes a job that runs after a prerender.remove() render nothing.
export const pinOnRevalidate: Pick<
  PrerenderConfig<AppBindings>,
  "onRevalidate"
> = {
  onRevalidate: (target, liveEnv, ctx) =>
    bind({ env: liveEnv, ctx })(target, { onlyIfStale: true }).then(() => {}),
};
