import { createLoader } from "@rangojs/router";
import {
  readActionBoundaryCart,
  readActionBoundaryNote,
} from "./action-boundary.store.js";

// Loaders only, so the client build gets id stubs for this module.

/** The layout's cart count, on the default revalidation. */
export const ActionBoundaryCartLoader = createLoader(async () =>
  readActionBoundaryCart(),
);

/**
 * The layout's note count. Its revalidate() re-runs it on the note action
 * only (action-boundary.tsx), so a later action's boundary response keeps it.
 */
export const ActionBoundaryNoteLoader = createLoader(async () =>
  readActionBoundaryNote(),
);
