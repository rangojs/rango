"use client";

import { Link, useHref, useRouter } from "@rangojs/router/client";

/**
 * useHref() and relative useRouter().push under the parameterized
 * `/cr/:tenantId` include() mount. Both fill the mount's params from the
 * current match, so neither produces a URL with a literal ":tenantId".
 */
export function CRMountParamNav() {
  const href = useHref();
  const router = useRouter();

  return (
    <div data-testid="cr-cf-mount-param-nav">
      <span data-testid="cr-cf-href-post">{href("/posts/p7")}</span>
      <Link to={href("/posts/p7")} data-testid="cr-cf-href-link">
        useHref link to p7
      </Link>
      <button
        type="button"
        data-testid="cr-cf-push-post"
        onClick={() => router.push("posts/p8")}
      >
        relative push to p8
      </button>
    </div>
  );
}
