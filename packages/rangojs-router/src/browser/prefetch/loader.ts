import type { RscPayload } from "../types.js";
import type { EventController } from "../event-controller.js";
import { observeForPrefetch as observeElementForPrefetch } from "./observer.js";

type PrefetchDecoder = (response: Promise<Response>) => Promise<RscPayload>;

type PrefetchRuntime = typeof import("./runtime.js");

let runtime: PrefetchRuntime | null = null;
let runtimePromise: Promise<PrefetchRuntime> | null = null;
let decoder: PrefetchDecoder | null = null;
let concurrency: number | undefined;
let requestGeneration = 0;

function loadRuntime(): Promise<PrefetchRuntime> {
  if (runtime) return Promise.resolve(runtime);
  if (!runtimePromise) {
    runtimePromise = import("./runtime.js").then(
      (loaded) => {
        runtime = loaded;
        if (decoder) loaded.setPrefetchDecoder(decoder);
        if (concurrency !== undefined) {
          loaded.setPrefetchConcurrency(concurrency);
        }
        return loaded;
      },
      (error: unknown) => {
        runtimePromise = null;
        throw error;
      },
    );
  }
  return runtimePromise;
}

function withRuntime(run: (loaded: PrefetchRuntime) => void): void {
  if (runtime) {
    run(runtime);
    return;
  }
  const generation = requestGeneration;
  void loadRuntime()
    .then((loaded) => {
      if (generation === requestGeneration) run(loaded);
    })
    .catch(() => {});
}

export function setPrefetchDecoder(fn: PrefetchDecoder): void {
  decoder = fn;
  runtime?.setPrefetchDecoder(fn);
}

export function setPrefetchConcurrency(value: number): void {
  concurrency = value;
  runtime?.setPrefetchConcurrency(value);
}

export function prefetchDirect(
  url: string,
  segmentIds: string[],
  version?: string,
  routerId?: string,
  prefetchKey?: ":source",
): void {
  withRuntime((loaded) =>
    loaded.prefetchDirect(url, segmentIds, version, routerId, prefetchKey),
  );
}

export function prefetchQueued(
  url: string,
  segmentIds: string[],
  version?: string,
  routerId?: string,
  prefetchKey?: ":source",
): void {
  withRuntime((loaded) =>
    loaded.prefetchQueued(url, segmentIds, version, routerId, prefetchKey),
  );
}

export function observeForPrefetch(
  element: Element,
  callback: () => void,
): () => void {
  if (typeof IntersectionObserver === "undefined") return () => {};
  return observeElementForPrefetch(element, callback);
}

/** Run speculative work only when no navigation or stream is active. */
export function schedulePrefetchWhenRouterIdle(
  eventController: Pick<EventController, "getState" | "subscribe">,
  callback: () => void,
): (() => void) | undefined {
  const state = eventController.getState();
  if (state.state === "idle" && !state.isStreaming) {
    callback();
    return;
  }

  const unsubscribe = eventController.subscribe(() => {
    const nextState = eventController.getState();
    if (nextState.state === "idle" && !nextState.isStreaming) {
      unsubscribe();
      callback();
    }
  });
  return unsubscribe;
}

export function cancelAllPrefetches(keepUrl?: string | null): void {
  requestGeneration++;
  runtime?.cancelAllPrefetches(keepUrl);
}

export function abortAllPrefetches(): void {
  requestGeneration++;
  runtime?.abortAllPrefetches();
}
