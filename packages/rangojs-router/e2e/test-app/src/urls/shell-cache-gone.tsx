import { createLoader, Meta, notFound } from "@rangojs/router";
import { ShellGoneView } from "../components/ShellGoneView.js";
import { shellGoneDeleted } from "./shell-cache-gone-records.js";

// Issue #1213 fixture: a ppr route whose ssr: false loader answers notFound()
// once its record is deleted (/shell-cache/gone-delete/:id). The shell
// captured while the record existed is retired by the next recapture.

export interface ShellGoneData {
  name: string;
}

export const ShellGoneLoader = createLoader(
  async (ctx): Promise<ShellGoneData> => {
    const id = ctx.params.id!;
    if (shellGoneDeleted.has(id)) notFound(`Deleted: ${id}`);
    ctx.use(Meta)({ title: `Record ${id}` });
    return { name: `record ${id}` };
  },
);

export function ShellGonePage() {
  return (
    <main data-testid="shell-gone-page">
      <ShellGoneView loader={ShellGoneLoader} />
    </main>
  );
}
