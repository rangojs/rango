import { PprInlineView } from "../components/PprInlineView.js";
import { PprInlineLoader } from "../loaders/ppr-inline.js";

export function PprInlinePage() {
  return (
    <main data-testid="ppr-inline-page">
      <PprInlineView loader={PprInlineLoader} />
    </main>
  );
}
