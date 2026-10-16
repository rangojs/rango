import { createLoader, notFound, redirect, urls } from "@rangojs/router";
import {
  HoleyShellHooks,
  HoleyShellIndex,
  HoleyShellReader,
  HoleyShellSsrThrower,
  HoleyShellTarget,
  HoleyThrowsLayout,
  HoleyThrowsView,
  type HoleyThrowsData,
} from "../components/HoleyThrowsView.js";
import { HoleyShellNotes, HoleyShellState } from "../components/holey-shell.js";

// dc-t92 fixture: an ssr: false loader whose value holds a promise (a pin with
// a hole, so the loader runs on every shell HIT). Once the probe's generation
// is bumped the loader throws. No errorBoundary() on the chain, except the
// bounded comparator's: the failure must end on the router's default error
// boundary, never on a blank page.
const generations = new Map<string, number>();
const generationOf = (probe: string): number => generations.get(probe) ?? 1;

export const HoleyThrowsLoader = createLoader(
  async (ctx): Promise<HoleyThrowsData> => {
    const generation = generationOf(ctx.searchParams.get("probe") ?? "");
    if (generation > 1) throw new Error(`holey-throws-error@g${generation}`);
    return {
      baked: `baked@g${generation}`,
      live: new Promise<string>((resolve) =>
        setTimeout(() => resolve(`live@g${generation}`), 800),
      ),
    };
  },
);

function HoleyThrowsPage() {
  return (
    <main data-testid="holey-page">
      <HoleyThrowsView loader={HoleyThrowsLoader} />
    </main>
  );
}

// A server component: a "use client" errorBoundary() fallback gave the MISS a 500 here.
export function HoleyBoundary({ error }: { error: Error }) {
  return (
    <p data-testid="holey-route-boundary">{`route-boundary: ${error.message}`}</p>
  );
}

// dc-t93 fixtures: each read has no <Suspense> above it, so the failure
// reaches React's server-render shell on a document load. Body:
// tests/shared-e2e/src/ssr-shell-error.ts.
export const HoleyShellLoader = createLoader(async (): Promise<string> => {
  throw new Error("holey-shell-loader-error");
});

export const HoleyShellNotFoundLoader = createLoader(
  async (): Promise<string> => {
    notFound("holey-shell-missing");
  },
);

export const HoleyShellRedirectLoader = createLoader(
  async (): Promise<string> => {
    throw redirect("/holey-throws/shell-target");
  },
);

export const HoleyShellRedirectStateLoader = createLoader(
  async (): Promise<string> => {
    throw redirect("/holey-throws/shell-target", {
      state: HoleyShellState({ text: "carried-by-redirect" }),
    });
  },
);

function shellPage(loader: typeof HoleyShellLoader) {
  return function HoleyShellPage() {
    return (
      <main data-testid="holey-shell-page">
        <HoleyShellReader loader={loader} />
      </main>
    );
  };
}

function HoleyShellSsrThrowPage() {
  return (
    <main data-testid="holey-shell-page">
      <HoleyShellSsrThrower />
    </main>
  );
}

export const holeyThrowsPatterns = urls(
  ({ path, layout, loader, errorBoundary }) => [
    layout(<HoleyThrowsLayout />, () => [
      path("/holey-throws/shell", () => <HoleyShellIndex />, {
        name: "holeyShell",
      }),
      path(
        "/holey-throws/shell-loader",
        shellPage(HoleyShellLoader),
        { name: "holeyShellLoader" },
        () => [loader(HoleyShellLoader)],
      ),
      path(
        "/holey-throws/shell-loader-bounded",
        shellPage(HoleyShellLoader),
        { name: "holeyShellLoaderBounded" },
        () => [loader(HoleyShellLoader), errorBoundary(HoleyBoundary)],
      ),
      path(
        "/holey-throws/shell-not-found",
        shellPage(HoleyShellNotFoundLoader),
        { name: "holeyShellNotFound" },
        () => [loader(HoleyShellNotFoundLoader)],
      ),
      path(
        "/holey-throws/shell-redirect",
        shellPage(HoleyShellRedirectLoader),
        { name: "holeyShellRedirect" },
        () => [loader(HoleyShellRedirectLoader)],
      ),
      path(
        "/holey-throws/shell-redirect-state",
        shellPage(HoleyShellRedirectStateLoader),
        { name: "holeyShellRedirectState" },
        () => [loader(HoleyShellRedirectStateLoader)],
      ),
      path("/holey-throws/shell-target", () => <HoleyShellTarget />, {
        name: "holeyShellTarget",
      }),
      path(
        "/holey-throws/shell-ppr",
        shellPage(HoleyShellLoader),
        { name: "holeyShellPpr", ppr: { ttl: 300, swr: 120 } },
        () => [loader(HoleyShellLoader)],
      ),
      path("/holey-throws/shell-ssr-throw", HoleyShellSsrThrowPage, {
        name: "holeyShellSsrThrow",
      }),
      path(
        "/holey-throws/shell-ssr-throw-bounded",
        HoleyShellSsrThrowPage,
        { name: "holeyShellSsrThrowBounded" },
        () => [errorBoundary(HoleyBoundary)],
      ),
      path(
        "/holey-throws/shell-hooks",
        (ctx) => {
          ctx.use(HoleyShellNotes)("from-the-handler");
          return (
            <main data-testid="holey-shell-page">
              <HoleyShellHooks />
              <HoleyShellSsrThrower />
            </main>
          );
        },
        { name: "holeyShellHooks" },
      ),
      path(
        "/holey-throws/document",
        HoleyThrowsPage,
        { name: "holeyThrowsDocument" },
        () => [loader(HoleyThrowsLoader, { ssr: false })],
      ),
      path(
        "/holey-throws/plain",
        HoleyThrowsPage,
        { name: "holeyThrowsPlain", ppr: { ttl: 300, swr: 120 } },
        () => [loader(HoleyThrowsLoader, { ssr: false })],
      ),
      path(
        "/holey-throws/bounded",
        HoleyThrowsPage,
        { name: "holeyThrowsBounded", ppr: { ttl: 300, swr: 120 } },
        () => [
          loader(HoleyThrowsLoader, { ssr: false }),
          errorBoundary(HoleyBoundary),
        ],
      ),
    ]),
    path.json(
      "/holey-throws/__bump",
      (ctx): { generation: number } => {
        const probe = ctx.searchParams.get("probe") ?? "";
        const next = generationOf(probe) + 1;
        generations.set(probe, next);
        return { generation: next };
      },
      { name: "holeyThrowsBump" },
    ),
  ],
);
