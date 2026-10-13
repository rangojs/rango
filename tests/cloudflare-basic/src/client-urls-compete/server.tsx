import { Link } from "@rangojs/router/client";

/**
 * A server route beside the client-urls-compete group whose URL the group's
 * `/:slug` also matches (../urls.tsx), linking to the group's intercept target.
 */
export function CompeteServerPage({
  text,
  detail,
}: {
  text: string;
  detail: string;
}) {
  return (
    <div data-testid="cmp-server">
      <p>{text}</p>
      <Link to={detail} prefetch="none" data-testid="cmp-server-to-detail">
        Detail
      </Link>
    </div>
  );
}
