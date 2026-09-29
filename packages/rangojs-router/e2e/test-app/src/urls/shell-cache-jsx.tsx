import { Suspense, type ReactNode } from "react";
import { createLoader } from "@rangojs/router";
import { ShellJsxView } from "../components/ShellJsxView.js";

// Issue #942 fixture: a bake-lane (ssr: false) loader value carrying JSX. The
// elements bake into the shell, the async server component included. The
// promise inside `live` (host elements) is the hole and the run stamp beside
// it stays pinned from the capture; `reviews` is a server component holding a
// promise, so that whole element is the hole.

let shellJsxRuns = 0;

async function ShellJsxRelated({ id }: { id: string }): Promise<ReactNode> {
  await Promise.resolve();
  return <p data-testid="shell-jsx-related">{`Related to ${id}`}</p>;
}

async function ShellJsxReviews({
  data,
}: {
  data: Promise<string>;
}): Promise<ReactNode> {
  return <p data-testid="shell-jsx-reviews">{await data}</p>;
}

export interface ShellJsxData {
  title: string;
  related: ReactNode;
  live: ReactNode;
  reviews: ReactNode;
}

export const ShellJsxLoader = createLoader(async (): Promise<ShellJsxData> => {
  shellJsxRuns += 1;
  const run = shellJsxRuns;
  return {
    title: "JSX from a bake-lane loader",
    related: (
      <section data-testid="shell-jsx-section">
        <h2>Related</h2>
        <ShellJsxRelated id="p1" />
      </section>
    ),
    live: (
      <div data-testid="shell-jsx-live-box">
        <p data-testid="shell-jsx-live-run">{`captured in run ${run}`}</p>
        <Suspense
          fallback={
            <span data-testid="shell-jsx-live-fallback">live pending...</span>
          }
        >
          <span data-testid="shell-jsx-live">
            {Promise.resolve(`live run ${run}`)}
          </span>
        </Suspense>
      </div>
    ),
    reviews: <ShellJsxReviews data={Promise.resolve(`reviews run ${run}`)} />,
  };
});

export function ShellJsxPage() {
  return (
    <main data-testid="shell-jsx-page">
      <ShellJsxView loader={ShellJsxLoader} />
    </main>
  );
}
