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
import { ErrorsThrowHandler, ErrorsUnhandledHandler } from "./errors.handlers.js";

export const errorsPatterns = urls(({ path, layout, loader, errorBoundary, notFoundBoundary }) => [
  layout(<ErrorsLayout />, () => [
    errorBoundary(errorsErrorBoundary),
    notFoundBoundary(errorsNotFoundBoundary),

    path("/", ErrorsIndexPage, { name: "index" }),
    path("/throw", ErrorsThrowHandler, { name: "throwError" }),
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
  path("/errors/unhandled", ErrorsUnhandledHandler, { name: "errors.unhandled" }),
]);
