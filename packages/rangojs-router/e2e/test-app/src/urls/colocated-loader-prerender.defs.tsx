import { createLoader, createHandle, Prerender, Static } from "@rangojs/router";

// ─── Loader + Handle + Prerender colocated in the same file ──────────────
// The bug: when a client component imports the loader (or handle) from this
// file, the Vite plugin's non-RSC transform stubs the Prerender() call via
// generateExprStubs and returns early, skipping $$id injection for the
// colocated loader and handle.

export const ColocatedLoader = createLoader(async () => {
  return { message: "colocated-loader-data", ts: Date.now() };
});

export const ColocatedHandle = createHandle<string>();

export const ColocatedStatic = Static(() => {
  return (
    <div data-testid="colocated-static-page">
      <h1 data-testid="colocated-static-title">Colocated Static</h1>
    </div>
  );
});

export const ColocatedPrerender = Prerender(async (ctx) => {
  const push = ctx.use(ColocatedHandle);
  push("prerender-item");

  return (
    <div data-testid="colocated-prerender-page">
      <h1 data-testid="colocated-prerender-title">Colocated Prerender</h1>
      <p data-testid="colocated-prerender-pushed">prerender-item</p>
    </div>
  );
});
