import { Suspense, type ReactNode } from "react";
import { createLoader } from "@rangojs/router";

// Issue #942 fixture: a bake-lane (ssr: false) loader value carrying JSX. The
// elements bake into the shell, the async server component included. The
// promise inside `live` (host elements) is the hole and the run stamp beside
// it stays pinned from the capture; `reviews` is a server component holding a
// promise, so that whole element is the hole.

let pprJsxRuns = 0;

async function PprJsxRelated({ id }: { id: string }): Promise<ReactNode> {
  await Promise.resolve();
  return <p data-testid="ppr-jsx-related">{`Related to ${id}`}</p>;
}

async function PprJsxReviews({
  data,
}: {
  data: Promise<string>;
}): Promise<ReactNode> {
  return <p data-testid="ppr-jsx-reviews">{await data}</p>;
}

export interface PprJsxData {
  title: string;
  related: ReactNode;
  live: ReactNode;
  reviews: ReactNode;
}

export const PprJsxLoader = createLoader(async (): Promise<PprJsxData> => {
  pprJsxRuns += 1;
  const run = pprJsxRuns;
  return {
    title: "JSX from a bake-lane loader",
    related: (
      <section data-testid="ppr-jsx-section">
        <h2>Related</h2>
        <PprJsxRelated id="p1" />
      </section>
    ),
    live: (
      <div data-testid="ppr-jsx-live-box">
        <p data-testid="ppr-jsx-live-run">{`captured in run ${run}`}</p>
        <Suspense
          fallback={
            <span data-testid="ppr-jsx-live-fallback">live pending...</span>
          }
        >
          <span data-testid="ppr-jsx-live">
            {Promise.resolve(`live run ${run}`)}
          </span>
        </Suspense>
      </div>
    ),
    reviews: <PprJsxReviews data={Promise.resolve(`reviews run ${run}`)} />,
  };
});
