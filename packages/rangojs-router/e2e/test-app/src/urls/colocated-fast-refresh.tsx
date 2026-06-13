import { urls } from "@rangojs/router";
import { ColocatedFrIsland } from "../components/ColocatedFrIsland.js";
import { ColocatedFrServerNote } from "../components/ColocatedFrShared.js";

// Server route for the colocated Fast Refresh regression guard. Importing
// ColocatedFrServerNote from ColocatedFrShared.tsx places that shared file in
// the rsc module graph; the island renders ColocatedFrMarker from the same
// file on the client. The shared file therefore lives in both graphs without a
// "use client" directive of its own, the shape vite-plugin-react#1248
// addresses. Because the shared file's only client-graph importer (the island)
// is a "use client" client reference, isInsideClientBoundary short-circuits
// plugin-rsc's client guard and Fast Refresh is preserved. This route pins
// that, so a future plugin-rsc bump cannot silently regress it.
function ColocatedFrPage() {
  return (
    <div data-testid="colocated-fr-page">
      <h1 data-testid="colocated-fr-title">Colocated Fast Refresh</h1>
      <ColocatedFrServerNote />
      <ColocatedFrIsland />
    </div>
  );
}

export const colocatedFastRefreshPatterns = urls(({ path }) => [
  path("/", ColocatedFrPage, { name: "index" }),
]);
