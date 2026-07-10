import type { RscPayload } from "../types.js";

type PrefetchDecoder = (response: Promise<Response>) => Promise<RscPayload>;

interface PrefetchRuntime {
  setPrefetchDecoder(fn: PrefetchDecoder): void;
  setPrefetchConcurrency(value: number): void;
  prefetchDirect(
    url: string,
    segmentIds: string[],
    version?: string,
    routerId?: string,
    prefetchKey?: ":source",
  ): void;
  prefetchQueued(
    url: string,
    segmentIds: string[],
    version?: string,
    routerId?: string,
    prefetchKey?: ":source",
  ): string;
  observeForPrefetch(element: Element, callback: () => void): void;
  unobserveForPrefetch(element: Element): void;
  cancelAllPrefetches(keepUrl?: string | null): void;
  abortAllPrefetches(): void;
}

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
  let active = true;
  if (runtime) {
    runtime.observeForPrefetch(element, callback);
  } else {
    void loadRuntime()
      .then((loaded) => {
        if (active) loaded.observeForPrefetch(element, callback);
      })
      .catch(() => {});
  }
  return () => {
    active = false;
    runtime?.unobserveForPrefetch(element);
  };
}

export function cancelAllPrefetches(keepUrl?: string | null): void {
  requestGeneration++;
  runtime?.cancelAllPrefetches(keepUrl);
}

export function abortAllPrefetches(): void {
  requestGeneration++;
  runtime?.abortAllPrefetches();
}
