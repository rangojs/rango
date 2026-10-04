import { Prerender } from "@rangojs/router";
import { PprPushView } from "../components/PprPushView.js";
import {
  PprPushDeferredLoader,
  PprPushLiveLoader,
  PprPushPinnedLoader,
  PprPushSettledLoader,
  PprPushSlowLoader,
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

// The view reads the live loader, so it renders inside the route's loading()
// boundary: a useHandle reader that hydrates after the root (#1035).
export function PprPushLivePage() {
  return (
    <main data-testid="ppr-push-live-page">
      <PprPushView loader={PprPushLiveLoader} />
    </main>
  );
}

export function PprPushSlowPage() {
  return (
    <main data-testid="ppr-push-slow-page">
      <PprPushView loader={PprPushSlowLoader} />
    </main>
  );
}

// #1057: Prerender + ppr. The prerender store supplies these views on every
// request; the shell entry keeps the loader pushes its HTML rendered.
export const PprPushPreSettledPage = Prerender(async () => (
  <main data-testid="ppr-push-pre-settled-page">
    <PprPushView loader={PprPushSettledLoader} />
  </main>
));

export const PprPushPreDeferredPage = Prerender(async () => (
  <main data-testid="ppr-push-pre-deferred-page">
    <PprPushView loader={PprPushDeferredLoader} />
  </main>
));

// The control: the same loader and view, ppr without Prerender.
export function PprPushPprSettledPage() {
  return (
    <main data-testid="ppr-push-ppr-settled-page">
      <PprPushView loader={PprPushSettledLoader} />
    </main>
  );
}
