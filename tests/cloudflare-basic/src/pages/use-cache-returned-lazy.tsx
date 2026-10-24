import { Suspense, type ReactElement } from "react";
import {
  getReturnedLazySession,
  getReturnedTreeConfig,
} from "../use-cache-returned-tree-data.js";

/**
 * urls.tsx /use-cache-returned-lazy/:probe: rendered in the page's Flight
 * render, so getReturnedTreeConfig is warm (React.cache) by the time the
 * page renders the cached value.
 */
export async function ReturnedLazyPage({
  probe,
}: {
  probe: string;
}): Promise<ReactElement> {
  await getReturnedTreeConfig();
  const block = await getReturnedLazySession(probe);
  return (
    <main data-testid="returned-lazy-page">
      <Suspense fallback={<i>loading</i>}>{block}</Suspense>
    </main>
  );
}
