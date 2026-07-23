import { createRouter } from "@rangojs/router";
import { Document } from "../../document.js";
import {
  PrefetchActionInvalidationButton,
  PrefetchInvalidationButton,
} from "./PrefetchInvalidationButton.js";

export const router = createRouter({
  document: Document,
  defaultPrefetch: "viewport",
}).routes(({ path }) => [
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
