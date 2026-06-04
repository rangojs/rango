import { createLoader } from "@rangojs/router";
import { getDashboardValue } from "./store.js";

// Registered (non-fetchable) loader: runs fresh on every request to /dashboard
// and re-runs after an action when the route's revalidate predicate matches.
export const DashboardLoader = createLoader(async () => {
  return {
    value: getDashboardValue(),
    at: new Date().toISOString(),
  };
});

// Fetchable loader: fetched on demand from the client via useFetchLoader (GET
// request). The `true` second argument marks the loader fetchable.
let fetchCount = 0;
export const FetchableLoader = createLoader(async (ctx) => {
  fetchCount += 1;
  const id = ctx.params.id || "default";
  // Small delay so the loading state is observable in tests.
  await new Promise((resolve) => setTimeout(resolve, 150));
  return {
    message: "Fetched via GET",
    id,
    count: fetchCount,
    at: new Date().toISOString(),
  };
}, true);
