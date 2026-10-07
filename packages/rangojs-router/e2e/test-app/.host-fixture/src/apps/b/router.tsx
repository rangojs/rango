import { createRouter } from "@rangojs/router";
import { cacheStore } from "../../cache-store.js";
import { Document } from "../../document.js";

export const router = createRouter({
  document: Document,
  cache: { store: cacheStore },
}).routes(({ path }) => [
  path("/", () => <main data-testid="app">App B home</main>, {
    name: "home",
  }),
  path("/shelled", () => <main data-testid="shelled">App B shelled</main>, {
    name: "shelled",
    ppr: true,
  }),
]);
