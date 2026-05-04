"use client";

import { Link, useMount, useParams, useReverse } from "@rangojs/router/client";
import { routes as clientReverseRoutes } from "../urls/client-reverse.gen.js";

// `clientReversePatterns` is mounted twice (/cr/a/:tenantId and /cr/b/:tenantId);
// scope generated Link targets to whichever mount this component renders under.
function crLinkTo(
  mount: string,
  tail: string,
): "/" | `/cr/a${string}` | `/cr/b${string}` {
  if (mount.startsWith("/cr/a/")) return `/cr/a${tail}` as `/cr/a${string}`;
  if (mount.startsWith("/cr/b/")) return `/cr/b${tail}` as `/cr/b${string}`;
  return "/";
}

function CaptureReverseError({
  testid,
  call,
}: {
  testid: string;
  call: () => string;
}) {
  let value: string;
  try {
    value = call();
  } catch (error) {
    value = `ERROR: ${(error as Error).message}`;
  }
  return <span data-testid={testid}>{value}</span>;
}

/**
 * Test surface for `useReverse(routes)`.
 *
 * Renders predictable text values for each `reverse()` shape so the e2e
 * spec can assert exact strings against current `useMount()` and
 * `useParams()` values.
 */
export function ClientReverseNav() {
  const mount = useMount();
  const params = useParams<{
    tenantId?: string;
    postId?: string;
    itemId?: string;
    section?: string;
    locale?: string;
  }>();
  const reverse = useReverse(clientReverseRoutes);

  return (
    <div data-testid="client-reverse-nav">
      <span data-testid="cr-mount">{mount}</span>
      <span data-testid="cr-tenant">{params.tenantId ?? ""}</span>

      <span data-testid="cr-index">{reverse(".index")}</span>

      <span data-testid="cr-detail-explicit">
        {reverse(".detail", { postId: "p1" })}
      </span>

      <span data-testid="cr-detail-autofill-tenant">
        {reverse(".detail", { postId: "p2" })}
      </span>

      <span data-testid="cr-detail-override-tenant">
        {reverse(".detail", { tenantId: "other", postId: "p2" })}
      </span>

      <span data-testid="cr-optional-omitted">
        {reverse(".optional", { itemId: "i1" })}
      </span>

      <span data-testid="cr-optional-given">
        {reverse(".optional", { itemId: "i1", section: "s1" })}
      </span>

      <span data-testid="cr-optional-empty-string">
        {reverse(".optional", { itemId: "i1", section: "" })}
      </span>

      <span data-testid="cr-locale">
        {reverse(".locale", { locale: "en" })}
      </span>

      <span data-testid="cr-search">
        {reverse(".searchRoute", {}, { q: "hello world", page: 2 })}
      </span>

      <span data-testid="cr-nested-index">{reverse(".nested.index")}</span>

      <CaptureReverseError
        testid="cr-unknown"
        call={() =>
          (reverse as unknown as (n: string) => string)(".not-a-route")
        }
      />

      <CaptureReverseError
        testid="cr-missing-param"
        call={() =>
          (
            reverse as unknown as (
              n: string,
              p?: Record<string, string>,
            ) => string
          )(".detail", {})
        }
      />

      <CaptureReverseError
        testid="cr-no-dot"
        call={() => (reverse as unknown as (n: string) => string)("index")}
      />

      <Link to={crLinkTo(mount, "/zeta")} data-testid="cr-link-switch-tenant">
        switch tenant
      </Link>

      <Link
        to={crLinkTo(mount, "/acme/posts/p1")}
        data-testid="cr-link-go-detail"
      >
        go to detail p1
      </Link>
    </div>
  );
}
