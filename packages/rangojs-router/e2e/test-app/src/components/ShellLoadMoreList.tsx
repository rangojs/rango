"use client";

import { useState } from "react";
import { useFetchLoader, useLoader, useRouter } from "@rangojs/router/client";
import {
  ShellLoadMoreLoader,
  ShellLoadMorePageLoader,
} from "../urls/shell-cache.defs.js";

/**
 * The /shell-cache/load-more list (issue #986). "Load more" appends the next
 * page to client state, then soft-navigates to ?page=N; the route's
 * revalidate() keeps this segment, so the accumulated list survives the
 * navigation. `data-route-page` is the page the last committed response
 * rendered for.
 */
export function ShellLoadMoreList({
  page,
  items,
}: {
  page: number;
  items: string[];
}) {
  const [list, setList] = useState(items);
  const [lastPage, setLastPage] = useState(page);
  const { load } = useFetchLoader(ShellLoadMoreLoader);
  const { data: rendered } = useLoader(ShellLoadMorePageLoader);
  const router = useRouter();

  const loadMore = async () => {
    const next = lastPage + 1;
    const { items: nextItems } = await load({
      params: { page: String(next) },
    });
    setList((current) => [...current, ...nextItems]);
    setLastPage(next);
    const url = new URL(window.location.href);
    url.searchParams.set("page", String(next));
    await router.push(url.pathname + url.search, { scroll: false });
  };

  return (
    <section data-testid="shell-load-more-list" data-route-page={rendered.page}>
      <ul data-testid="shell-load-more-items">
        {list.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <button
        type="button"
        data-testid="shell-load-more-button"
        onClick={loadMore}
      >
        Load more
      </button>
    </section>
  );
}
