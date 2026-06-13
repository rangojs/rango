// No "use client" directive. This file is imported by BOTH the server route
// (colocated-fast-refresh.tsx, which puts it in the rsc module graph) and the
// "use client" island (ColocatedFrIsland.tsx, which puts it in the client
// module graph). It thus lives in both graphs without a directive of its own:
// the exact precondition plugin-rsc's client-branch hotUpdate guard keys on,
// and the shape vite-plugin-react#1248 refines.
//
// Every export is a React component so the module stays a valid React Refresh
// boundary (a module mixing component and non-component exports would not
// self-accept), mirroring the upstream repro where both ServerNote and Page
// are components.

// Client-rendered marker, edited by the Fast Refresh HMR test. It is reached
// from the browser only via the "use client" island, so isInsideClientBoundary
// is true for this module and plugin-rsc's client guard never suppresses its
// HMR. Editing the text below must apply as Fast Refresh, not a dropped update.
export function ColocatedFrMarker() {
  return <span data-testid="colocated-fr-marker">marker-baseline</span>;
}

// Server-graph export: imported and rendered by the server route, which is what
// places this file in the rsc module graph (the dual-graph half of the guard's
// precondition). Never rendered on the client.
export function ColocatedFrServerNote() {
  return <p data-testid="colocated-fr-server-note">server-note</p>;
}
