"use client";

/**
 * The #1182 shape as an app writes it: a clientUrls() group (the default
 * export of a "use client" module) whose ppr page registers an ssr: false
 * loader that pushes its title to Meta as a promise.
 */
import { clientUrls } from "../../../client-urls/client-urls.js";
import type { ClientUrlPatterns } from "../../../client-urls/types.js";
import { AwaitedGridLoader, GridLoader } from "./loader-meta-promise-data.js";

function CategoryPage(): null {
  return null;
}

const group: ClientUrlPatterns = clientUrls(({ path, loader }) => [
  path("/c/:id", CategoryPage, { name: "category", ppr: true }, () => [
    loader(GridLoader, { ssr: false }),
  ]),
  path("/a/:id", CategoryPage, { name: "awaited", ppr: true }, () => [
    loader(AwaitedGridLoader, { ssr: false }),
  ]),
]);

export default group;
