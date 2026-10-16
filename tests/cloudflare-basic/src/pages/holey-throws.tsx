import { createLoader, urls } from "@rangojs/router";
import {
  HoleyThrowsLayout,
  HoleyThrowsView,
  type HoleyThrowsData,
} from "../components/HoleyThrowsView.js";

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

export const holeyThrowsPatterns = urls(
  ({ path, layout, loader, errorBoundary }) => [
    layout(<HoleyThrowsLayout />, () => [
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
