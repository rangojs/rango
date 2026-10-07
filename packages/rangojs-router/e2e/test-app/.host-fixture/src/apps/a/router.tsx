import { createRouter } from "@rangojs/router";
import { cacheStore } from "../../cache-store.js";
import { Document } from "../../document.js";
import {
  PrefetchActionInvalidationButton,
  PrefetchInvalidationButton,
} from "./PrefetchInvalidationButton.js";

export const router = createRouter({
  document: Document,
  defaultPrefetch: "viewport",
  cache: { store: cacheStore },
}).routes(({ path }) => [
  // App B has the same route name and path: with the hostOverride cookie
  // only the router tells the two shells apart.
  path("/shelled", () => <main data-testid="shelled">App A shelled</main>, {
    name: "shelled",
    ppr: true,
  }),
  path(
    "/",
    () => (
      <>
        <main data-testid="app">App A home</main>
        <a
          href="/?delegated-prefetch=1"
          data-testid="prefetch-invalidation-target"
        >
          Persistent invalidation target
        </a>
        <PrefetchInvalidationButton />
        <PrefetchActionInvalidationButton />
      </>
    ),
    {
      name: "home",
    },
  ),
]);
