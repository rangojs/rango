import { createRouter } from "@rangojs/router";
import { Document } from "../../document.js";

export const router = createRouter({ document: Document }).routes(
  ({ path }) => [
    path("/", () => <main data-testid="app">App A home</main>, {
      name: "home",
    }),
  ],
);
