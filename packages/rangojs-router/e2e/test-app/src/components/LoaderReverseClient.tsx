"use client";

import {
  useLoader,
  useFetchLoader,
  type LoaderDefinition,
} from "@rangojs/router/client";

interface ReverseUrls {
  blogIndex: string;
  blogPost: string;
  hrefIndex: string;
}

interface ScopedReverseUrls {
  localIndex: string;
  localDetail: string;
  globalBlog: string;
}

export function LoaderReverseClientGlobal({
  loader,
}: {
  loader: LoaderDefinition<ReverseUrls>;
}) {
  const { data } = useLoader<ReverseUrls>(loader);

  return (
    <section data-testid="client-loader-global-section">
      <h2>Client-bound loader: global reverse</h2>
      <ul>
        <li data-testid="client-loader-global-blog-index">{data.blogIndex}</li>
        <li data-testid="client-loader-global-blog-post">{data.blogPost}</li>
        <li data-testid="client-loader-global-href-index">{data.hrefIndex}</li>
      </ul>
    </section>
  );
}

export function LoaderReverseClientScoped({
  loader,
}: {
  loader: LoaderDefinition<ScopedReverseUrls>;
}) {
  const { data } = useLoader<ScopedReverseUrls>(loader);

  return (
    <section data-testid="client-loader-scoped-section">
      <h2>Client-bound loader: scoped reverse</h2>
      <ul>
        <li data-testid="client-loader-scoped-index">{data.localIndex}</li>
        <li data-testid="client-loader-scoped-detail">{data.localDetail}</li>
        <li data-testid="client-loader-scoped-global-blog">
          {data.globalBlog}
        </li>
      </ul>
    </section>
  );
}

interface FetchScopedReverseUrls extends ScopedReverseUrls {
  count: number;
}

export function LoaderReverseFetchScoped({
  loader,
}: {
  loader: LoaderDefinition<FetchScopedReverseUrls>;
}) {
  const { data, load } = useFetchLoader<FetchScopedReverseUrls>(loader);

  return (
    <section data-testid="fetch-loader-scoped-section">
      <h2>Fetch loader: scoped reverse (useFetchLoader)</h2>
      {data && (
        <ul>
          <li data-testid="fetch-loader-scoped-index">{data.localIndex}</li>
          <li data-testid="fetch-loader-scoped-detail">{data.localDetail}</li>
          <li data-testid="fetch-loader-scoped-global-blog">
            {data.globalBlog}
          </li>
          <li data-testid="fetch-loader-scoped-count">{data.count}</li>
        </ul>
      )}
      <button data-testid="fetch-loader-refetch" onClick={() => load()}>
        Refetch
      </button>
    </section>
  );
}
