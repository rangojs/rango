import type { RangoInternal } from "./router-interfaces.js";

/**
 * Dev only (#1186). A runner full reload clears its evaluated modules while a
 * request may still be loading them, splitting it across two router copies
 * whose registries disagree. A router of a dropped copy hands its requests to
 * the router the reload re-created, and a generated Node RSC entry of a
 * dropped copy to the entry the reload re-evaluated. docs/manifests.md, "A
 * request the reload split".
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

type Serve = () => Promise<Response>;

/**
 * Serves a request on this router copy, or on the router a runner full reload
 * re-created when the reload dropped this copy before the request or while it
 * ran. What a request imports after the clear is the fresh copy, so one the
 * reload lands inside fails or answers the wrong route: its outcome is
 * discarded. Only GET and HEAD re-run, since a re-run repeats side effects and
 * cannot re-read a body. A reload after the response is returned still splits
 * its stream.
 * @internal
 */
export async function serveAcrossRunnerReload(
  request: Request,
  serve: Serve,
  recreated: () => Promise<Serve | undefined>,
): Promise<Response> {
  if (runnerReloaded) {
    const rerun = await recreated();
    return (rerun ?? serve)();
  }
  if (request.method !== "GET" && request.method !== "HEAD") return serve();
  const settled = await serve().then(
    (response) => ({ response }),
    (error: unknown) => ({ error }),
  );
  const rerun = runnerReloaded ? await recreated() : undefined;
  if (rerun) {
    if ("response" in settled) {
      void settled.response.body?.cancel().catch(() => {});
    }
    return rerun();
  }
  if ("error" in settled) throw settled.error;
  return settled.response;
}

/**
 * Polls `read` until it yields a value or DEV_RECREATED_ROUTER_WAIT_MS runs
 * out.
 */
async function waitForRecreated<T>(
  read: () => T | undefined | Promise<T | undefined>,
): Promise<T | undefined> {
  const deadline = Date.now() + DEV_RECREATED_ROUTER_WAIT_MS;
  let value = await read();
  while (value === undefined && Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, DEV_RECREATED_ROUTER_POLL_MS),
    );
    value = await read();
  }
  return value;
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
  return waitForRecreated(() => RouterRegistry.get(routerId));
}

/** The default export of the generated Node RSC entries (virtual-entries.ts). */
type EntryHandler = (request: Request, input?: any) => Promise<Response>;

let registeredEntry: EntryHandler | undefined;

/**
 * Called by a generated RSC entry as its last statement, so this module copy
 * holds the entry only once everything the entry imports has evaluated: the
 * routes-manifest bootstrap installs the clientUrls() projections before the
 * router module runs. Handing a request to the entry's `default` any earlier
 * fails the same way the split request did: the runner exposes an unfinished
 * module's hoisted function exports before its imports finish.
 * @internal
 */
export function registerEntryHandler(entry: EntryHandler): void {
  registeredEntry = entry;
}

/**
 * The entry registered with this module copy.
 * @internal
 */
export function registeredEntryHandler(): EntryHandler | undefined {
  return registeredEntry;
}

/**
 * The entry a runner full reload re-evaluated, other than `dropped`, or
 * undefined when none registered within DEV_RECREATED_ROUTER_WAIT_MS. The
 * runner re-imports its entrypoints after the clear, so this only waits.
 * Each poll imports this module again: it resolves to the copy that is
 * current at that moment, which moves on when a second reload lands while
 * the first re-import is still evaluating, and is still this copy between
 * `vite:beforeFullReload` and the clear that follows it.
 */
async function entryAfterRunnerReload(
  dropped: EntryHandler,
): Promise<EntryHandler | undefined> {
  return waitForRecreated(async () => {
    const current: typeof import("./dev-reload-handoff.js") =
      await import("./dev-reload-handoff.js");
    const entry = current.registeredEntryHandler();
    return entry === dropped ? undefined : entry;
  });
}

/**
 * Dev only. Serves a request on the generated Node RSC entry `entry`, which
 * calls createRSCHandler without `router.fetch` and so without its hand-off,
 * or re-runs it on the entry a runner full reload re-evaluated, under
 * serveAcrossRunnerReload's rules.
 * @internal
 */
export function serveEntryAcrossRunnerReload(
  request: Request,
  input: unknown,
  entry: EntryHandler,
  serve: Serve,
): Promise<Response> {
  return serveAcrossRunnerReload(request, serve, async () => {
    const recreated = await entryAfterRunnerReload(entry);
    return recreated ? () => recreated(request, input) : undefined;
  });
}
