import { createLoader } from "@rangojs/router";

// Live hole under the frozen PPR shell (docs/design/ppr-shell-resume.md). ~400ms
// so the shell prelude clearly beats the hole; seq advances on every request to
// prove loaders stay fresh while the shell is served from the cached prelude.
// Directive-free so the client price component can import it by identity
// (useLoader) without pulling the route factory into the client graph.
const SHELL_LOADER_DELAY_MS = 400;

export interface ShellPriceData {
  price: number;
  seq: number;
  loadedAt: number;
}

let shellPriceSeq = 0;

export const ShellPriceLoader = createLoader(
  async (): Promise<ShellPriceData> => {
    await new Promise((resolve) => setTimeout(resolve, SHELL_LOADER_DELAY_MS));
    shellPriceSeq += 1;
    return { price: 42, seq: shellPriceSeq, loadedAt: Date.now() };
  },
);

// Loader-carried promise: the deterministic streaming lane under a PPR hole
// (docs/design/ppr-shell-resume.md). Resolves its OUTER value fast but carries a
// NESTED promise settling ~300ms later. FlightSerialize preserves the nested
// Promise (src/serialize.ts), so the client use()s it under its OWN inner
// Suspense — a second streaming layer INSIDE the loader hole. One loader backs
// both /shell-cache/stream (WITH loading(): the hole; HIT streams three layers)
// and /shell-cache/no-hole (NO loading(): capture refuses, eternal MISS, but the
// inner promise still streams under axis 1).
const SHELL_STREAM_INNER_DELAY_MS = 300;

export interface ShellStreamData {
  label: string;
  pendingData: Promise<string>;
}

let shellStreamSeq = 0;

export const ShellStreamLoader = createLoader(
  async (): Promise<ShellStreamData> => {
    shellStreamSeq += 1;
    const seq = shellStreamSeq;
    const pendingData = new Promise<string>((resolve) =>
      setTimeout(
        () => resolve(`Streamed inner ${seq}`),
        SHELL_STREAM_INNER_DELAY_MS,
      ),
    );
    return { label: "Streamed outer", pendingData };
  },
);
