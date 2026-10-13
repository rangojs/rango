"use client";

import { Link, useHref, useRouter } from "@rangojs/router/client";

/**
 * useHref() and relative useRouter().push under a parameterized include()
 * mount (`/cr/a/:tenantId`). Both fill the mount's params from the current
 * match, so neither produces a URL with a literal ":tenantId".
 */
export function MountParamNav() {
  const href = useHref();
  const router = useRouter();

  return (
    <div data-testid="mount-param-nav">
      <span data-testid="mount-href-detail">{href("/posts/p7")}</span>
      <Link to={href("/posts/p7")} data-testid="mount-href-link">
        useHref link to p7
      </Link>
      <button
        type="button"
        data-testid="mount-push-detail"
        onClick={() => router.push("posts/p8")}
      >
        relative push to p8
      </button>
    </div>
  );
}
