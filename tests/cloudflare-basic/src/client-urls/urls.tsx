"use client";

import type { ReactNode } from "react";
import { Suspense } from "react";
import {
  clientUrls,
  Link,
  useLoader,
  useOutlet,
  useParams,
} from "@rangojs/router/client";
import { ClientUrlsDetailLoader } from "./loader.js";
import { MirrorPlpLoader } from "../loaders/chrome-mirror.js";

/* Consumer-app repro (workerd variant): pure-HTML CategoryButton tree fed by
 * a LITERAL object, sitting in a Suspense boundary beside a text-only
 * boundary and a loader-fed boundary — the exact three-boundary signature
 * from the consumer artifact (text boundary completed, component boundaries
 * emitted <!--$?--> + fallback on a live MISS). */
function MirrorCategoryButton({
  name,
  productsCount,
}: {
  name: string;
  productsCount: number | null;
}) {
  return (
    <div className="border-light-gray flex flex-col items-center rounded-lg border p-2">
      <div className="h-[60px] w-[100px]">{null}</div>
      <div className="max-w-[100px] pt-2 text-center">
        <p className="text-sm">{name}</p>
      </div>
      <div className="pt-[5px]">
        <p className="text-xs">({productsCount ?? 0})</p>
      </div>
    </div>
  );
}

function MirrorCategoriesButtons({
  category,
}: {
  category: {
    showSubcategoriesOnPLP: boolean;
    subcategories: {
      id: string;
      name: string;
      productsCount: number | null;
      showCategoryOnPLP: boolean;
    }[];
  } | null;
}) {
  if (!category?.showSubcategoriesOnPLP) return null;
  const subcategories = category.subcategories;
  if (subcategories.length === 0) return null;
  if (!subcategories.some((s) => s.showCategoryOnPLP)) return null;
  return (
    <div className="mx-6 overflow-hidden" data-testid="mirror-catbuttons">
      {subcategories.map((s) =>
        s.showCategoryOnPLP ? (
          <MirrorCategoryButton
            key={s.id}
            name={s.name}
            productsCount={s.productsCount}
          />
        ) : null,
      )}
    </div>
  );
}

function MirrorResults(): ReactNode {
  const { data } = useLoader(MirrorPlpLoader);
  return (
    <div id="store-mirror" className="top-0 mb-16 w-full">
      <Suspense fallback={"|done fallback|"}>done</Suspense>
      <Suspense fallback={"|CategoriesButtons fallback|"}>
        <MirrorCategoriesButtons
          category={{
            showSubcategoriesOnPLP: true,
            subcategories: [
              {
                id: "1",
                name: "literal-probe",
                productsCount: 1,
                showCategoryOnPLP: true,
              },
            ],
          }}
        />
      </Suspense>
      <Suspense fallback={"|List|"}>
        <div data-testid="mirror-list">{data.marker} — list content</div>
      </Suspense>
    </div>
  );
}

function ClientUrlsLayout(): ReactNode {
  const outlet = useOutlet();

  return (
    <main data-testid="client-urls-layout">
      <h1>Pure client routes</h1>
      <nav aria-label="Pure client route navigation">
        <Link to="/" data-testid="client-urls-main-nav">
          Server route examples
        </Link>
        <Link to="/__client-urls" data-testid="client-urls-index-nav">
          Pure client index
        </Link>
      </nav>
      <output data-testid="client-urls-pending">
        {String(outlet.pending)}
      </output>
      {outlet.content}
    </main>
  );
}

function ClientUrlsIndex(): ReactNode {
  return (
    <section data-testid="client-urls-index">
      <h2>Client URLs index</h2>
      <Link
        to="/__client-urls/deterministic-slug"
        prefetch="none"
        data-testid="client-urls-detail-link"
      >
        Open detail
      </Link>
    </section>
  );
}

function ClientUrlsDetail(): ReactNode {
  const { slug } = useParams<{ slug: string }>();
  const { data } = useLoader(ClientUrlsDetailLoader);

  return (
    <section data-testid="client-urls-detail">
      <h2>Client URLs detail</h2>
      <p data-testid="client-urls-param">{slug}</p>
      <p data-testid="client-urls-loader">{data.slug}</p>
      <Link
        to="/__client-urls"
        prefetch="none"
        data-testid="client-urls-back-link"
      >
        Back to index
      </Link>
    </section>
  );
}

function ClientUrlsLoading(): ReactNode {
  return (
    <section data-testid="client-urls-loading">
      Loading client URL detail
    </section>
  );
}

export default clientUrls(({ layout, path, loader, loading }) => [
  layout(ClientUrlsLayout, () => [
    path("/", ClientUrlsIndex),
    path("/:slug", ClientUrlsDetail, () => [
      loader(ClientUrlsDetailLoader),
      loading(<ClientUrlsLoading />),
    ]),
    path("/mirror/:slug", MirrorResults, () => [
      loader(MirrorPlpLoader, { ssr: false }),
    ]),
  ]),
]);
