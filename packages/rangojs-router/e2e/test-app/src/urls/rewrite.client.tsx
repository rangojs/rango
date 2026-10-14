"use client";

import {
  Link,
  useLoader,
  usePathname,
  useSearchParams,
  type LoaderDefinition,
} from "@rangojs/router/client";

/** The location a rewritten page hydrates with: the visitor's URL. */
export function RwClientLocation() {
  const pathname = usePathname();
  const [search] = useSearchParams();
  const query = search.toString();
  return (
    <span data-testid="rw-client-location">
      {query ? `${pathname}?${query}` : pathname}
    </span>
  );
}

/**
 * The item page's loader run that produced its data, and a link to another
 * sort at the visitor's URL (#1144): a navigation that holds the loader keeps
 * the count.
 */
export function RwItemLoads({
  loader,
}: {
  loader: LoaderDefinition<{ loads: number }>;
}) {
  const { data } = useLoader(loader);
  const pathname = usePathname();
  return (
    <>
      <span data-testid="rw-item-loads">{String(data.loads)}</span>
      <Link to={`${pathname}?sort=b`} data-testid="rw-item-sort">
        Sort b
      </Link>
    </>
  );
}
