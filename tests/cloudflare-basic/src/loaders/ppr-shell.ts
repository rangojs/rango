import { createLoader } from "@rangojs/router";

// Physics fixture: a handler-created promise passed as a PROP to a client
// component that use()s it under its own <Suspense>. Genuinely pending real I/O
// (~250ms) cannot win the capture's task-quantized quiet window, so the boundary
// postpones — a HOLE by physics, not by registration. Deterministic value (no
// drift; the resumed HTML and hydration payload come from the same tail render).
const PPR_PHYSICS_DELAY_MS = 250;

export function makePprPhysicsPromise(): Promise<string> {
  return new Promise((resolve) =>
    setTimeout(() => resolve("PHYSICS-HOLE-VALUE"), PPR_PHYSICS_DELAY_MS),
  );
}

// The live hole under the frozen PPR shell (docs/design/ppr-shell-resume.md).
// A ~400ms loader whose seq advances on EVERY request: it proves loaders stay
// fresh (the hole is re-run per request) while the shell prelude is served from
// cache. During shell capture the loader is masked, so this subtree postpones and
// becomes the hole; on serve it runs fresh and resumes into the frozen shell.
const PPR_SHELL_LOADER_DELAY_MS = 400;

export interface PprShellPriceData {
  price: number;
  seq: number;
  loadedAt: number;
}

let pprPriceSeq = 0;

export const PprShellPriceLoader = createLoader(
  async (): Promise<PprShellPriceData> => {
    await new Promise((resolve) =>
      setTimeout(resolve, PPR_SHELL_LOADER_DELAY_MS),
    );
    pprPriceSeq += 1;
    return { price: 42, seq: pprPriceSeq, loadedAt: Date.now() };
  },
);

// Loader-carried promise: the deterministic streaming lane under a PPR hole
// (docs/design/ppr-shell-resume.md). The loader resolves its OUTER value fast
// but carries a NESTED promise that settles ~300ms later. FlightSerialize
// preserves the nested Promise (src/serialize.ts), so the client use()s it under
// its OWN inner Suspense — a second streaming layer INSIDE the loader hole.
//
// Two routes share this one loader to pin the whole contract:
//   /ppr-shell/stream   (WITH loading()) -> the loading() boundary is the hole;
//                        on a HIT the resume streams three layers in one body:
//                        cached shell -> outer + inner fallback -> inner content.
//   /ppr-shell/no-hole  (NO loading())  -> capture refuses (masked loader pins
//                        the tree-build await), so x-rango-shell stays MISS
//                        forever; the inner promise STILL streams under axis 1.
//                        No loading() degrades only the caching, never the route.
const PPR_STREAM_INNER_DELAY_MS = 300;

export interface PprShellStreamData {
  label: string;
  // Nested promise: settles after the outer value, streamed under an inner
  // Suspense on the client.
  pendingData: Promise<string>;
}

let pprStreamSeq = 0;

export const PprShellStreamLoader = createLoader(
  async (): Promise<PprShellStreamData> => {
    pprStreamSeq += 1;
    const seq = pprStreamSeq;
    const pendingData = new Promise<string>((resolve) =>
      setTimeout(
        () => resolve(`Streamed inner ${seq}`),
        PPR_STREAM_INNER_DELAY_MS,
      ),
    );
    return { label: "Streamed outer", pendingData };
  },
);
