import { PprJsxView } from "../components/PprJsxView.js";
import { PprJsxLoader } from "../loaders/ppr-jsx.js";

export function PprJsxPage() {
  return (
    <main data-testid="ppr-jsx-page">
      <PprJsxView loader={PprJsxLoader} />
    </main>
  );
}
