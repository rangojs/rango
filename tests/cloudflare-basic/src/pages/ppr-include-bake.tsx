import { urls } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { PprIncludeChrome } from "../components/PprIncludeChrome.js";

// Issue #1179 fixture (e2e/ppr-include-bake.test.ts): one ppr page declared
// directly under the store layout and mounted through include() under it.

export function PprIncludeBakeLayout() {
  return (
    <PprIncludeChrome>
      <Outlet />
    </PprIncludeChrome>
  );
}

export function PprIncludeBakePage() {
  return <main data-testid="ppr-include-page">PPR include page</main>;
}

export const pprIncludeSectionPatterns = urls(({ path }) => [
  path("/page", PprIncludeBakePage, {
    name: "page",
    ppr: { ttl: 300, swr: 120 },
  }),
]);
