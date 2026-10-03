import { PprPushView } from "../components/PprPushView.js";
import {
  PprPushDeferredLoader,
  PprPushPinnedLoader,
} from "../loaders/ppr-push-ownership.js";

// Push-ownership fixture pages (e2e/ppr-push-ownership.test.ts): a loader's
// data and the handle values it pushed come from one run on every replay of
// a shell.

export function PprPushPinnedPage() {
  return (
    <main data-testid="ppr-push-pinned-page">
      <PprPushView loader={PprPushPinnedLoader} />
    </main>
  );
}

export function PprPushDeferredPage() {
  return (
    <main data-testid="ppr-push-deferred-page">
      <PprPushView loader={PprPushDeferredLoader} />
    </main>
  );
}
