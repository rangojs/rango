import { urls } from "@rangojs/router";
import {
  ErrorsIndexHandler,
  ErrorsClientErrorHandler,
  ErrorsServerErrorHandler,
  ErrorsStreamingErrorHandler,
} from "./errors.handlers.js";

/**
 * Error test routes URL patterns
 * Routes: errors.index, errors.clientError, errors.serverError, errors.streamingError
 */
export const errorsPatterns = urls(({ path, loading }) => [
  path("/errors", ErrorsIndexHandler, { name: "errors.index" }),
  path("/errors/client-error", ErrorsClientErrorHandler, {
    name: "errors.clientError",
  }),
  path("/errors/server-error", ErrorsServerErrorHandler, {
    name: "errors.serverError",
  }),
  path(
    "/errors/streaming-error",
    ErrorsStreamingErrorHandler,
    { name: "errors.streamingError" },
    () => [
      loading(
        <div data-testid="streaming-error-loading">
          <p>Loading streaming content...</p>
        </div>,
      ),
    ],
  ),
]);
