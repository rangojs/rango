import { createLoader, Meta, notFound } from "@rangojs/router";
import { pprGoneDeleted } from "./ppr-gone-records.js";

// Issue #1213 fixture: a ppr route whose ssr: false loader answers notFound()
// once its record is deleted (/ppr-gone-delete/:id). The shell captured while
// the record existed is retired by the next recapture.

export interface PprGoneData {
  name: string;
}

export const PprGoneLoader = createLoader(async (ctx): Promise<PprGoneData> => {
  const id = ctx.params.id!;
  if (pprGoneDeleted.has(id)) notFound(`Deleted: ${id}`);
  ctx.use(Meta)({ title: `Record ${id}` });
  return { name: `record ${id}` };
});
