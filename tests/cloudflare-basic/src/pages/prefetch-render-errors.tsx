import type { ReactNode } from "react";
import { urls } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import {
  PrefetchRenderLoaderPage,
  PrefetchRenderNav,
} from "./prefetch-render-errors.client.js";
import { SettledLaneFlakyLoader } from "./settled-lane-errors.loaders.js";
import { nextPrefetchRenderRun } from "./prefetch-render-errors.state.js";

// A prefetch whose render reported an error is never kept: one whose
// loading() handler or loader failed is not served to a click or from the
// HTTP cache, and a click that adopted one mid-stream renders it whole (e2e/prefetch-render-errors.test.ts, body in
// tests/shared-e2e). Each handler fails on its run's first call only.
function flaky(route: string, delayMs = 0) {
  return async (ctx: { searchParams: URLSearchParams }): Promise<ReactNode> => {
    const run = ctx.searchParams.get("run") ?? "none";
    const n = nextPrefetchRenderRun(`${route}:${run}`);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (n === 1) throw new Error(`${route} unavailable`);
    return <p data-testid="pre-value">{`${route}:${n}`}</p>;
  };
}

const skeleton = <p data-testid="pre-skeleton">loading</p>;
const boundary = <p data-testid="pre-boundary">failed</p>;

export const prefetchRenderErrorsPatterns = urls(
  ({ path, layout, loader, loading, errorBoundary }) => [
    layout(PrefetchRenderLayout, () => [
      path("/", () => <p data-testid="pre-home">home</p>, { name: "home" }),
      path("/handler", flaky("handler"), { name: "handler" }, () => [
        loading(skeleton),
        errorBoundary(boundary),
      ]),
      path("/slow", flaky("slow", 1500), { name: "slow" }, () => [
        loading(skeleton),
        errorBoundary(boundary),
      ]),
      path(
        "/loader",
        () => <PrefetchRenderLoaderPage />,
        { name: "loader" },
        () => [loader(SettledLaneFlakyLoader), loading(skeleton)],
      ),
    ]),
  ],
);

export function PrefetchRenderLayout(): ReactNode {
  return (
    <section data-testid="pre-layout">
      <PrefetchRenderNav />
      <Outlet />
    </section>
  );
}
