import { PprGoneView } from "../components/PprGoneView.js";
import { PprGoneLoader } from "../loaders/ppr-gone.js";

export function PprGonePage() {
  return (
    <main data-testid="ppr-gone-page">
      <PprGoneView loader={PprGoneLoader} />
    </main>
  );
}
