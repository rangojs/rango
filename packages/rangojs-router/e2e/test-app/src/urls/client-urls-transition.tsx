"use client";

import {
  clientUrls,
  Link,
  useLoader,
  useOutlet,
  useParams,
} from "@rangojs/router/client";
import { ClientUrlsItemLoader } from "./client-urls.loader.js";
import type { TransitionWhenContext } from "@rangojs/router";

/**
 * clientUrls() transition({ when }): declared inline here, run in the browser;
 * ?gate=off on the destination gates the navigation off. Every call is logged
 * to window.__ctWhenLog.
 */
function logCtWhen(
  name: string,
  ctx: TransitionWhenContext,
  result: boolean,
): boolean {
  if (typeof window !== "undefined") {
    const w = window as unknown as { __ctWhenLog?: unknown[] };
    (w.__ctWhenLog ??= []).push({
      name,
      kind: ctx.kind,
      from: ctx.from.url.pathname + ctx.from.url.search,
      to: ctx.to.url.pathname + ctx.to.url.search,
      fromParams: { ...ctx.from.params },
      toParams: { ...ctx.to.params },
      toRouteName: ctx.to.routeName,
      result,
    });
  }
  return result;
}

const gateOff = (ctx: TransitionWhenContext): boolean =>
  ctx.to.url.searchParams.get("gate") !== "off";

/**
 * clientUrls() group pinning the data-only transition() projection on a
 * SAME-route param nav (one -> two). Group route segments are keyed by the
 * group, so BOTH twins hold previous content (no skeleton flash); transition()
 * adds the view-transition animation config on top. Same observable as e2e/conditional-transition.test.ts, driven
 * here through the client-declared config.
 */

function TransitionClientLayout() {
  const { content, pending } = useOutlet();

  return (
    <section data-testid="ct-layout" data-pending={String(pending)}>
      <h2>Transition client group</h2>
      {content}
    </section>
  );
}

function TransitionClientItem() {
  const { data } = useLoader(ClientUrlsItemLoader);
  const params = useParams();

  return (
    <article data-testid="ct-item">
      <span data-testid="ct-item-param">{params.itemId}</span>
      <span data-testid="ct-item-loader">{data}</span>
      <Link
        to="/client-urls-transition/items/two"
        prefetch="none"
        data-testid="ct-item-to-two"
      >
        Item two
      </Link>
      <Link
        to="/client-urls-transition/items/three?gate=off"
        prefetch="none"
        data-testid="ct-item-to-three-gated"
      >
        Item three (gated off)
      </Link>
      <Link
        to="/client-urls-transition/other/one?gate=off"
        prefetch="none"
        data-testid="ct-item-to-other-gated"
      >
        Other one (cross-route, gated off)
      </Link>
    </article>
  );
}

/** Cross-route destination: decided at the optimistic swap. */
function TransitionClientOther() {
  const { data } = useLoader(ClientUrlsItemLoader);
  const params = useParams();

  return (
    <article data-testid="ct-other">
      <span data-testid="ct-other-param">{params.itemId}</span>
      <span data-testid="ct-other-loader">{data}</span>
    </article>
  );
}

function TransitionClientOtherLoading() {
  return <div data-testid="ct-other-loading">Loading other</div>;
}

function TransitionClientItemLoading() {
  return <div data-testid="ct-item-loading">Loading item</div>;
}

function TransitionClientPlain() {
  const { data } = useLoader(ClientUrlsItemLoader);
  const params = useParams();

  return (
    <article data-testid="ct-plain">
      <span data-testid="ct-plain-param">{params.itemId}</span>
      <span data-testid="ct-plain-loader">{data}</span>
      <Link
        to="/client-urls-transition/plain/two"
        prefetch="none"
        data-testid="ct-plain-to-two"
      >
        Plain two
      </Link>
    </article>
  );
}

function TransitionClientPlainLoading() {
  return <div data-testid="ct-plain-loading">Loading plain</div>;
}

export default clientUrls(({ layout, path, loader, loading, transition }) => [
  layout(TransitionClientLayout, () => [
    path("/items/:itemId", TransitionClientItem, { name: "item" }, () => [
      loader(ClientUrlsItemLoader),
      loading(<TransitionClientItemLoading />),
      transition({
        name: "ct-item",
        viewTransition: "auto",
        when: (ctx) => logCtWhen("item", ctx, gateOff(ctx)),
      }),
    ]),
    path("/other/:itemId", TransitionClientOther, { name: "other" }, () => [
      loader(ClientUrlsItemLoader),
      loading(<TransitionClientOtherLoading />),
      transition({ when: (ctx) => logCtWhen("other", ctx, gateOff(ctx)) }),
    ]),
    path("/plain/:itemId", TransitionClientPlain, { name: "plain" }, () => [
      loader(ClientUrlsItemLoader),
      loading(<TransitionClientPlainLoading />),
    ]),
  ]),
]);
