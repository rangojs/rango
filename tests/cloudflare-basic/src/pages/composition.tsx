import {
  urls,
  cache,
  revalidate,
  loading,
  errorBoundary,
  middleware,
  layout,
} from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";

// Composable callback factories using globally imported helpers
const withCaching = () => [
  cache({ ttl: 600_000 }),
  revalidate(({ actionId }) => !!actionId),
];

const withLoadingAndError = () => [
  loading(<div data-testid="composition-loading">Loading composition...</div>),
  errorBoundary(() => (
    <div data-testid="composition-error">Something went wrong</div>
  )),
];

const withPassthroughMiddleware = () => [
  middleware(async (_ctx: any, next: any) => next()),
];

function CompositionIndexPage() {
  return (
    <div data-testid="composition-index">
      <h1>Composition Test</h1>
      <p>This route uses globally imported helpers for composition.</p>
    </div>
  );
}

function CompositionDetailPage() {
  return (
    <div data-testid="composition-detail">
      <h1>Composition Detail</h1>
      <p>This route reuses the same composition factories.</p>
    </div>
  );
}

export const compositionPatterns = urls(({ path }) => [
  layout(<Outlet />, () => [
    withPassthroughMiddleware(),
    path("/", CompositionIndexPage, { name: "index" }, () => [
      withCaching(),
      withLoadingAndError(),
    ]),
    path("/detail", CompositionDetailPage, { name: "detail" }, () => [
      withCaching(),
      withLoadingAndError(),
    ]),
  ]),
]);
