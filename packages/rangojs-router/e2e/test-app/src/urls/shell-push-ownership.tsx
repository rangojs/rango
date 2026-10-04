import { urls } from "@rangojs/router";
import {
  ShellPushDeferredLoader,
  ShellPushPinnedLoader,
  bumpShellPushGeneration,
} from "./shell-push-ownership.defs.js";
import { ShellPushView } from "../components/ShellPushView.js";

// Push-ownership fixture (e2e/shell-push-ownership.test.ts): a loader's data
// and the handle values it pushed come from one run on every replay of a
// shell. Every loader is `ssr: false`, so no route needs loading().

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

export const shellPushOwnershipPatterns = urls(({ path, loader, cache }) => [
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
  // Test-only: moves the fixture's generation for one ?probe= on.
  path.json(
    "/shell-push/__bump",
    (ctx): { generation: number } => ({
      generation: bumpShellPushGeneration(ctx.searchParams.get("probe") ?? ""),
    }),
    { name: "shellPushBump" },
  ),
]);
