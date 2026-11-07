import type { RscBrowserDependencies, RscPayload } from "../types.js";
import type { EventController } from "../event-controller.js";
import type { PrefetchDecoder } from "./fetch.js";
import { expandPayloadFragments } from "../../segment-fragments.js";

/**
 * The prefetch decoder of a browser app: the navigation's createFromFetch,
 * then every segment fragment envelope expanded before the decoded payload
 * enters the prefetch cache, so cached entries only ever resolve to expanded
 * segments; a fragment-decode failure rejects the entry's payload and rides
 * the cache's eviction path. A speculative prefetch passes its hold's filter,
 * so a fragment's preloads are held like the response's.
 */
export function createPrefetchDecoder(
  deps: Pick<
    RscBrowserDependencies,
    "createFromFetch" | "createFromReadableStream"
  >,
): PrefetchDecoder {
  return async (response, filterFragment) => {
    const payload = await deps.createFromFetch<RscPayload>(response);
    await expandPayloadFragments(
      payload,
      filterFragment
        ? (stream) => deps.createFromReadableStream(filterFragment(stream))
        : deps.createFromReadableStream,
    );
    return payload;
  };
}

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
