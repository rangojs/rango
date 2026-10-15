import { urls } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { PprIncludeChrome } from "../components/PprIncludeChrome.js";
import { PprIncludeChromeLoader } from "./ppr-include-bake.defs.js";

// Issue #1179 fixture (e2e/ppr-include-bake.test.ts): a store layout whose
// client chrome reads its ssr: false loader outside Suspense, over one ppr
// page declared directly and mounted through include(). This module is itself
// mounted through include(), so the inner include captures its parent on the
// runtime expansion; tests/cloudflare-basic declares the layout in the root
// urls(), where router.routes() captures it.

function PprIncludeBakeLayout() {
  return (
    <PprIncludeChrome>
      <Outlet />
    </PprIncludeChrome>
  );
}

function PprIncludeBakePage() {
  return <main data-testid="ppr-include-page">PPR include page</main>;
}

const pprIncludeSectionPatterns = urls(({ path }) => [
  path("/page", PprIncludeBakePage, { name: "page", ppr: true }),
]);

export const pprIncludeBakePatterns = urls(
  ({ layout, loader, path, include }) => [
    layout(PprIncludeBakeLayout, () => [
      loader(PprIncludeChromeLoader, { ssr: false }),
      path("/ppr-include/direct", PprIncludeBakePage, {
        name: "pprIncludeDirect",
        ppr: true,
      }),
      include("/ppr-include/section", pprIncludeSectionPatterns, {
        name: "pprIncludeSection",
      }),
    ]),
  ],
);
