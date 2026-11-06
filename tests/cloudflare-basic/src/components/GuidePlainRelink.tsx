"use client";

import { Link } from "@rangojs/router/client";

/**
 * A client navigation back to the page that rendered this link, with a search
 * param so it is not the current URL. The e2e clicks it once a refresh stored a
 * redirect for the route: the partial request the click sends is the one the
 * stored redirect answers. `prefetch="none"`: a prefetched answer from before
 * the move would short-circuit that request.
 */
export function GuidePlainRelink({
  href,
  testId,
}: {
  href: string;
  testId: string;
}): React.ReactNode {
  return (
    <Link to={href} prefetch="none" data-testid={testId}>
      relink
    </Link>
  );
}
