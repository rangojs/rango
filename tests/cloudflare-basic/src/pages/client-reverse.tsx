import { urls } from "@rangojs/router";
import { CRClientNav } from "../components/CRClientNav.js";
import { CRMountParamNav } from "../components/CRMountParamNav.js";

/**
 * Minimal urls module for the cloudflare-basic useReverse() e2e.
 * Mounted in urls.tsx under `/cr/:tenantId` so the spec can verify
 * the client hook resolves through `useMount()` + `useParams()`
 * autofill on the Cloudflare preset. CRMountParamNav covers useHref() and
 * relative useRouter().push under the same parameterized mount.
 */
function CRPage() {
  return (
    <>
      <CRClientNav />
      <CRMountParamNav />
    </>
  );
}

export const clientReversePatterns = urls(({ path }) => [
  path("/", () => <CRPage />, { name: "index" }),
  path("/posts/:postId", () => <CRPage />, { name: "post" }),
]);
