import { urls } from "@rangojs/router";
import { ClientReverseNav } from "../components/ClientReverseNav.js";
import { MountParamNav } from "../components/MountParamNav.js";

/**
 * URL patterns for the client-side useReverse() hook tests.
 *
 * The same `clientReversePatterns` is mounted twice in `urls.tsx` under
 * different prefixes (`/cr/a/:tenantId` and `/cr/b/:tenantId`) to verify
 * that `useReverse(routes)` resolves against the surrounding `useMount()`
 * value rather than a fixed include scope.
 *
 * The mount carries a `:tenantId` segment so the autofill behavior of
 * `useReverse` (currentParams from `useParams()`) can be exercised
 * without the routes themselves needing to repeat the param.
 */
const clientReverseNestedPatterns = urls(({ path }) => [
  path("/", () => <ClientReverseNav />, { name: "index" }),
]);

/** useReverse surface plus the useHref / relative push surface. */
function MountedNavs() {
  return (
    <>
      <ClientReverseNav />
      <MountParamNav />
    </>
  );
}

export const clientReversePatterns = urls(({ path, include }) => [
  path("/", () => <MountedNavs />, { name: "index" }),
  path("/posts/:postId", () => <MountedNavs />, { name: "detail" }),
  path("/items/:itemId/:section?", () => <ClientReverseNav />, {
    name: "optional",
  }),
  path("/locale/:locale(en|gb)", () => <ClientReverseNav />, {
    name: "locale",
  }),
  path("/search", () => <ClientReverseNav />, {
    name: "searchRoute",
    search: { q: "string", page: "number?" },
  }),
  include("/nested", clientReverseNestedPatterns, { name: "nested" }),
]);
