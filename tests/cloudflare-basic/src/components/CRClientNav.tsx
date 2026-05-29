"use client";

import { Link, useParams, useReverse } from "@rangojs/router/client";
import { routes as crRoutes } from "../pages/client-reverse.gen.js";

/**
 * Minimal client surface for the useReverse() e2e on cloudflare-basic.
 * Renders resolved URLs as text so the spec can assert exact values.
 */
export function CRClientNav() {
  const params = useParams<{ tenantId?: string; postId?: string }>();
  const reverse = useReverse(crRoutes);

  return (
    <div data-testid="cr-cf-nav">
      <span data-testid="cr-cf-tenant">{params.tenantId ?? ""}</span>

      <span data-testid="cr-cf-index">{reverse(".index")}</span>

      <span data-testid="cr-cf-post-explicit">
        {reverse(".post", { postId: "p1" })}
      </span>

      <span data-testid="cr-cf-post-autofill">
        {reverse(".post", { postId: "p2" })}
      </span>

      <span data-testid="cr-cf-post-override">
        {reverse(".post", { tenantId: "other", postId: "p2" })}
      </span>

      <Link
        to={params.tenantId === "acme" ? "/cr/zeta" : "/cr/acme/posts/p1"}
        data-testid="cr-cf-link"
      >
        switch
      </Link>
    </div>
  );
}
