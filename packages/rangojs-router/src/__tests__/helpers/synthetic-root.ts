/**
 * The synthetic MapRootLayout entry a mount's routes are registered under
 * (router.ts routes()), for tests that drive include() capture and
 * loadManifest without the full router.
 *
 * Not shipped with the npm package (lives in __tests__/).
 */
import { createElement } from "react";
import type { EntryData } from "../../server/context.js";

const ROOT_HANDLER = createElement("div");

export function makeSyntheticRoot(mountIndex = 0): EntryData {
  return {
    type: "layout",
    id: `#synthetic-maproot-M${mountIndex}`,
    shortCode: `M${mountIndex}L0`,
    parent: null,
    handler: ROOT_HANDLER,
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    layout: [],
    parallel: {},
    intercept: [],
    loader: [],
  };
}
