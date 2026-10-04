import { Prerender, urls } from "@rangojs/router";
import {
  ShellPushDeferredLoader,
  ShellPushLiveLoader,
  ShellPushPinnedLoader,
  ShellPushSettledLoader,
  bumpShellPushGeneration,
} from "./shell-push-ownership.defs.js";
import { ShellPushView } from "../components/ShellPushView.js";

// Push-ownership fixture (e2e/shell-push-ownership.test.ts): a loader's data
// and the handle values it pushed come from one run on every replay of a
// shell. Those loaders are `ssr: false`, so their routes need no loading().
// /shell-push/live is the #1035 fixture: a live loader under loading().

function ShellPushPinnedPage() {
  return (
    <main data-testid="shell-push-pinned-page">
      <ShellPushView loader={ShellPushPinnedLoader} />
    </main>
  );
}

function ShellPushDeferredPage() {
  return (
    <main data-testid="shell-push-deferred-page">
      <ShellPushView loader={ShellPushDeferredLoader} />
    </main>
  );
}

// The view reads the live loader, so it renders inside the route's loading()
// boundary: a useHandle reader that hydrates after the root (#1035).
function ShellPushLivePage() {
  return (
    <main data-testid="shell-push-live-page">
      <ShellPushView loader={ShellPushLiveLoader} />
    </main>
  );
}

// #1057: Prerender + ppr. The prerender store supplies these views on every
// request; the shell entry keeps the loader pushes its HTML rendered.
export const ShellPushPreSettledPage = Prerender(async () => (
  <main data-testid="shell-push-pre-settled-page">
    <ShellPushView loader={ShellPushSettledLoader} />
  </main>
));

export const ShellPushPreDeferredPage = Prerender(async () => (
  <main data-testid="shell-push-pre-deferred-page">
    <ShellPushView loader={ShellPushDeferredLoader} />
  </main>
));

// The control: the same loader and view, ppr without Prerender.
function ShellPushPprSettledPage() {
  return (
    <main data-testid="shell-push-ppr-settled-page">
      <ShellPushView loader={ShellPushSettledLoader} />
    </main>
  );
}

export const shellPushOwnershipPatterns = urls(
  ({ path, loader, loading, cache }) => [
    // #1003: the loader runs on every replay; its pin serves the data, so
    // the shell record's copy of its push stands, on a navigation too.
    path(
      "/shell-push/pinned",
      ShellPushPinnedPage,
      { name: "shellPushPinned", ppr: { ttl: 300, swr: 120 } },
      () => [loader(ShellPushPinnedLoader, { ssr: false })],
    ),
    // The same loader on an entry whose pins maxSnapshotBytes drops: the
    // loader runs fresh on a HIT, so its run's push replaces the record's.
    path(
      "/shell-push/capped",
      ShellPushPinnedPage,
      {
        name: "shellPushCapped",
        ppr: { ttl: 300, swr: 120, maxSnapshotBytes: 1 },
      },
      () => [loader(ShellPushPinnedLoader, { ssr: false })],
    ),
    // #1001: the deferred push reaches a replay from the loader's own
    // cache() entry.
    path(
      "/shell-push/deferred",
      ShellPushDeferredPage,
      { name: "shellPushDeferred", ppr: { ttl: 300, swr: 120 } },
      () => [
        loader(ShellPushDeferredLoader, { ssr: false }, () => [
          cache({ ttl: 300 }),
        ]),
      ],
    ),
    // #1035: a live loader that pushes after an await, read (data and handle)
    // inside its loading() boundary, which hydrates after the root.
    path(
      "/shell-push/live",
      ShellPushLivePage,
      { name: "shellPushLive", ppr: { ttl: 300, swr: 120 } },
      () => [
        loader(ShellPushLiveLoader),
        loading(<p data-testid="push-loading">Loading note...</p>),
      ],
    ),
    // #1057: Prerender + ppr. The prerender store supplies the handler layer,
    // so the shell entry keeps the loader's settled push itself.
    path(
      "/shell-push/pre-settled",
      ShellPushPreSettledPage,
      { name: "shellPushPreSettled", ppr: { ttl: 300, swr: 120 } },
      () => [loader(ShellPushSettledLoader, { ssr: false })],
    ),
    // The control: the same loader and view without Prerender.
    path(
      "/shell-push/ppr-settled",
      ShellPushPprSettledPage,
      { name: "shellPushPprSettled", ppr: { ttl: 300, swr: 120 } },
      () => [loader(ShellPushSettledLoader, { ssr: false })],
    ),
    // #1057 next to #1054: a promise push on a Prerender + ppr route.
    path(
      "/shell-push/pre-deferred",
      ShellPushPreDeferredPage,
      { name: "shellPushPreDeferred", ppr: { ttl: 300, swr: 120 } },
      () => [loader(ShellPushDeferredLoader, { ssr: false })],
    ),
    // Test-only: moves the fixture's generation for one ?probe= on.
    path.json(
      "/shell-push/__bump",
      (ctx): { generation: number } => ({
        generation: bumpShellPushGeneration(
          ctx.searchParams.get("probe") ?? "",
        ),
      }),
      { name: "shellPushBump" },
    ),
  ],
);
