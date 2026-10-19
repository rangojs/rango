import { createLoader } from "@rangojs/router";
import { ShellInlineView } from "../components/ShellInlineView.js";

// Issue #1206 fixture: a ppr route with an ssr: false loader and a completed
// Suspense boundary past both Fizz outlining gates (ShellInlineView). The live
// render and the shell capture both keep it in place. `live` is a promise, so
// the shell has a hole and a HIT resumes it.

export interface ShellInlineData {
  live: Promise<string>;
}

export const ShellInlineLoader = createLoader(
  async (): Promise<ShellInlineData> => ({
    live: Promise.resolve("inline live"),
  }),
);

export function ShellInlinePage() {
  return (
    <main data-testid="shell-inline-page">
      <ShellInlineView loader={ShellInlineLoader} />
    </main>
  );
}
