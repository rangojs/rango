import { urls } from "@rangojs/router";
import {
  ErrorsLayout,
  ErrorsIndexPage,
  ErrorsLoaderErrorPage,
  ErrorsNotFoundLoaderPage,
  ErrorsClientErrorPage,
  errorsErrorBoundary,
  errorsNotFoundBoundary,
} from "../pages/errors.js";
import { ErrorPageLoader, NotFoundLoader } from "../handlers/error-handlers.js";

export const errorsPatterns = urls(({ path, layout, loader, errorBoundary, notFoundBoundary }) => [
  layout(<ErrorsLayout />, () => [
    errorBoundary(errorsErrorBoundary),
    notFoundBoundary(errorsNotFoundBoundary),

    path("/", ErrorsIndexPage, { name: "index" }),
    path(
      "/throw",
      () => {
        throw new Error("Simulated handler error - something went wrong!");
      },
      { name: "throwError" }
    ),
    path("/loader-error", ErrorsLoaderErrorPage, { name: "loaderError" }, () => [
      loader(ErrorPageLoader),
    ]),
    path("/not-found", ErrorsNotFoundLoaderPage, { name: "notFound" }),
    path("/not-found-loader", ErrorsNotFoundLoaderPage, { name: "notFoundLoader" }, () => [
      loader(NotFoundLoader),
    ]),
    path("/client-error", ErrorsClientErrorPage, { name: "clientError" }),
  ]),
]);

// Unhandled error route - exported separately (no error boundary in parent chain)
export const unhandledErrorPattern = urls(({ path }) => [
  path(
    "/errors/unhandled",
    () => {
      throw new Error("This error is NOT caught by any route error boundary - it bubbles to root");
    },
    { name: "errors.unhandled" }
  ),
]);
