"use client";

/**
 * A clientUrls() group with a module-local intercept, mounted under a
 * parameterized include() (`/:locale`, `/:locale?`) by
 * client-urls-param-mount.rsc-test.tsx.
 */
import { clientUrls } from "../../../client-urls/client-urls.js";
import type { ClientUrlPatterns } from "../../../client-urls/types.js";

function Index(): null {
  return null;
}
function Product(): null {
  return null;
}
function Detail(): null {
  return null;
}
function DetailModal(): null {
  return null;
}

const group: ClientUrlPatterns = clientUrls(({ path, intercept }) => [
  path("/", Index, { name: "index" }),
  path("/:slug", Product, { name: "product" }),
  path("/detail/:id", Detail, { name: "detail" }),
  intercept("@modal", ".detail", DetailModal),
]);

export default group;
