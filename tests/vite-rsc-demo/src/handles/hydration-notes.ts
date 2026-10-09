import { createHandle } from "@rangojs/router";

/**
 * Notes the /hydration demo pushes: one from the layout, one from each route,
 * and one from LateNoteLoader after an await. The default collect keeps one
 * array per segment; readers flatten it.
 */
export const HydrationNotes = createHandle<string>();
