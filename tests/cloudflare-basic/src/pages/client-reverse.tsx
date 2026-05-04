import { urls } from "@rangojs/router";
import { CRClientNav } from "../components/CRClientNav.js";

/**
 * Minimal urls module for the cloudflare-basic useReverse() e2e.
 * Mounted in urls.tsx under `/cr/:tenantId` so the spec can verify
 * the client hook resolves through `useMount()` + `useParams()`
 * autofill on the Cloudflare preset.
 */
export const clientReversePatterns = urls(({ path }) => [
  path("/", () => <CRClientNav />, { name: "index" }),
  path("/posts/:postId", () => <CRClientNav />, { name: "post" }),
]);
