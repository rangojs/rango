"use client";

import { Link } from "@rangojs/router/client";

/**
 * A client `<Link>` to a plain on-demand page, rendered on a page that is not
 * in the prerender store: the e2e uses it to reach a stored page the way a
 * visitor does (a client navigation), not only as a document request
 * (e2e/on-demand-prerender.test.ts, a redirecting refresh keeps the page).
 */
export function OnDemandNavLink({ slug }: { slug: string }) {
  return (
    <Link to={`/on-demand-plain/${slug}`} data-testid="od-nav-link">
      {`open ${slug}`}
    </Link>
  );
}
