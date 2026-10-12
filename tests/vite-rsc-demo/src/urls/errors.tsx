import { urls, Meta } from "@rangojs/router";
import {
  RevalidationDemoLayout,
  RevalidationLocal,
  RevalidationLocalLoading,
  RevalidationRouteBoundary,
  revalidationStockErrorBoundary,
  ErrorsLayout,
  ErrorsIndexPage,
  ErrorsLoaderErrorPage,
  ErrorsNotFoundLoaderPage,
  ErrorsClientErrorPage,
  errorsErrorBoundary,
  errorsNotFoundBoundary,
} from "../pages/errors.js";
import { ErrorPageLoader, NotFoundLoader } from "../handlers/error-handlers.js";
import {
  SaveStatusLoader,
  StockFailureFlagLoader,
  StockLoader,
} from "../handlers/errors-revalidation/loaders.js";
import { setStockRefreshFailure } from "../handlers/errors-revalidation/actions.js";
import { StockSkeleton } from "../components/RevalidationDemo.js";
import revalidationGroupUrls from "./errors-revalidation.client.js";
import {
  ErrorsThrowHandler,
  ErrorsUnhandledHandler,
} from "./errors.handlers.js";

export const errorsPatterns = urls(
  ({
    path,
    layout,
    loader,
    loading,
    errorBoundary,
    notFoundBoundary,
    revalidate,
    include,
  }) => [
    layout(
      (ctx) => {
        ctx.use(Meta)({ title: "Errors" });
        return <ErrorsLayout />;
      },
      () => [
        errorBoundary(errorsErrorBoundary),
        notFoundBoundary(errorsNotFoundBoundary),

        path("/", ErrorsIndexPage, { name: "index" }),
        path("/throw", ErrorsThrowHandler, { name: "throwError" }),
        path(
          "/loader-error",
          ErrorsLoaderErrorPage,
          { name: "loaderError" },
          () => [loader(ErrorPageLoader)],
        ),
        path("/not-found", ErrorsNotFoundLoaderPage, { name: "notFound" }),
        path(
          "/not-found-loader",
          ErrorsNotFoundLoaderPage,
          { name: "notFoundLoader" },
          () => [loader(NotFoundLoader)],
        ),
        path("/client-error", ErrorsClientErrorPage, { name: "clientError" }),

        // A Save action whose revalidation reruns a loader that throws
        // (dc-t28): the action resolves and the loader throws at its read.
        // The stock loader skips the toggle action, so Save reruns it.
        layout(RevalidationDemoLayout, () => [
          loader(StockFailureFlagLoader),
          path(
            "/revalidation",
            RevalidationLocal,
            { name: "revalidation" },
            () => [
              loader(StockLoader, () => [
                revalidate(({ isAction }) =>
                  isAction(setStockRefreshFailure) ? false : undefined,
                ),
              ]),
              loader(SaveStatusLoader),
            ],
          ),
          path(
            "/revalidation/loading",
            RevalidationLocalLoading,
            { name: "revalidationLoading" },
            () => [
              loader(StockLoader, () => [
                revalidate(({ isAction }) =>
                  isAction(setStockRefreshFailure) ? false : undefined,
                ),
              ]),
              loader(SaveStatusLoader),
              loading(<StockSkeleton />),
            ],
          ),
          path(
            "/revalidation/route-boundary",
            RevalidationRouteBoundary,
            { name: "revalidationRouteBoundary" },
            () => [
              loader(StockLoader, () => [
                revalidate(({ isAction }) =>
                  isAction(setStockRefreshFailure) ? false : undefined,
                ),
              ]),
              loader(SaveStatusLoader),
              errorBoundary(revalidationStockErrorBoundary),
            ],
          ),
          include("/revalidation/group", revalidationGroupUrls, {
            name: "revalidationGroup",
          }),
        ]),
      ],
    ),
  ],
);

// Unhandled error route - exported separately (no error boundary in parent chain)
export const unhandledErrorPattern = urls(({ path }) => [
  path("/errors/unhandled", ErrorsUnhandledHandler, {
    name: "errors.unhandled",
  }),
]);
