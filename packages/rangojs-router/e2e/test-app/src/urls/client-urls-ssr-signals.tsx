"use client";

import { clientUrls, useLoader, useOutlet } from "@rangojs/router/client";
import {
  SsrNotFoundPageLoader,
  SsrRedirectChildLoader,
  SsrRedirectLayoutLoader,
  SsrRedirectPageLoader,
} from "./client-urls-ssr-signals.loader.js";

function LayoutReader() {
  const { data } = useLoader(SsrRedirectLayoutLoader);
  const { content } = useOutlet();
  return (
    <div data-testid="cu-ssr-redirect-layout" data-value={String(data)}>
      {content}
    </div>
  );
}

function LayoutPage() {
  return <div data-testid="cu-ssr-redirect-layout-page">layout page</div>;
}

function ChildReadingLayout() {
  const { data } = useLoader(SsrRedirectChildLoader);
  const { content } = useOutlet();
  return (
    <div data-testid="cu-ssr-redirect-child-layout" data-value={String(data)}>
      {content}
    </div>
  );
}

function ChildPage() {
  return <div data-testid="cu-ssr-redirect-child-page">child page</div>;
}

function NotFoundReader() {
  const { data } = useLoader(SsrNotFoundPageLoader);
  return <div data-testid="cu-ssr-notfound-page">{String(data)}</div>;
}

function PageReader() {
  const { data } = useLoader(SsrRedirectPageLoader);
  return <div data-testid="cu-ssr-redirect-page">{String(data)}</div>;
}

export default clientUrls(({ layout, path, loader }) => [
  layout(LayoutReader, () => [
    loader(SsrRedirectLayoutLoader, { ssr: false }),
    path("/layout", LayoutPage),
  ]),
  path("/page", PageReader, () => [
    loader(SsrRedirectPageLoader, { ssr: false }),
  ]),
  layout(ChildReadingLayout, () => [
    path("/child", ChildPage, () => [
      loader(SsrRedirectChildLoader, { ssr: false }),
    ]),
  ]),
  path("/notfound", NotFoundReader, () => [
    loader(SsrNotFoundPageLoader, { ssr: false }),
  ]),
]);
