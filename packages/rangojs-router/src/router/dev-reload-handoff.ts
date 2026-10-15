import type { RangoInternal } from "./router-interfaces.js";

/**
 * Dev only (#1186). A runner full reload clears its evaluated modules while a
 * request may still be loading them, splitting it across two router copies
 * whose registries disagree. A router of a dropped copy hands its requests to
 * the router the reload re-created. docs/manifests.md, "A request the reload
 * split".
 */
let runnerReloaded = false;

/**
 * Bound on the wait for the re-created router. cloudflare-basic's entry took
 * about 5 s to re-evaluate after the optimizer's `invalidateAll`.
 */
const DEV_RECREATED_ROUTER_WAIT_MS = 10_000;
const DEV_RECREATED_ROUTER_POLL_MS = 20;

/** The `import.meta.hot` subset this reads. */
interface RunnerReloadEvents {
  on(event: "vite:beforeFullReload", listener: () => void): void;
}

/**
 * Mark this module copy dropped on the runner's next full reload.
 * @internal
 */
export function watchRunnerReloads(
  events: RunnerReloadEvents | undefined,
): void {
  events?.on("vite:beforeFullReload", () => {
    runnerReloaded = true;
  });
}

if (process.env.NODE_ENV !== "production") {
  watchRunnerReloads(import.meta.hot);
}

/**
 * Whether a runner full reload dropped this module copy.
 * @internal
 */
export function droppedByRunnerReload(): boolean {
  return runnerReloaded;
}

/**
 * The router the reload re-created for `routerId`, or undefined when none
 * registered within DEV_RECREATED_ROUTER_WAIT_MS. Importing `sourceFile`
 * evaluates it when nothing else is. While the reload's re-import is still
 * evaluating it, the runner returns the unfinished module (it is in this
 * copy's import call stack, `cachedRequest` in vite's module-runner), so this
 * waits for the fresh registry to receive the router.
 * @internal
 */
export async function routerAfterRunnerReload(
  routerId: string,
  sourceFile: string | undefined,
): Promise<RangoInternal<any, any> | undefined> {
  if (!sourceFile) return undefined;
  await import(/* @vite-ignore */ sourceFile);
  const { RouterRegistry } = await import("./router-registry.js");
  const deadline = Date.now() + DEV_RECREATED_ROUTER_WAIT_MS;
  let router = RouterRegistry.get(routerId);
  while (!router && Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, DEV_RECREATED_ROUTER_POLL_MS),
    );
    router = RouterRegistry.get(routerId);
  }
  return router;
}
