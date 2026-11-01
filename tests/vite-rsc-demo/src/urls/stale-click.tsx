import { urls, Meta } from "@rangojs/router";
import { todosStore } from "../handlers/todos/data.js";

/**
 * The destination of the stale-prefetch e2e (prefetch.test.ts): it shows how
 * many todos exist, so a prefetch made before the /todos form adds one shows
 * the old count and the revalidation after the click shows the new one.
 */
export const staleClickPatterns = urls(({ path }) => [
  path(
    "/",
    (ctx) => {
      ctx.use(Meta)({ title: "Stale click" });
      return (
        <main>
          <h1>Stale click</h1>
          <p data-testid="stale-click-count">{todosStore.length}</p>
        </main>
      );
    },
    { name: "index" },
  ),
]);
