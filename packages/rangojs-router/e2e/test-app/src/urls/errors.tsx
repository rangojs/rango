import { urls } from "@rangojs/router";
import { SlotAncestorLayout } from "../components/SlotAncestorLayout.js";
import {
  ErrorsIndexHandler,
  ErrorsClientErrorHandler,
  ErrorsServerErrorHandler,
  ErrorsStreamingErrorHandler,
  ErrorsRenderingErrorHandler,
  ErrorsStreamingDeclaredHandler,
  ErrorsStreamingDeclaredNoSsrHandler,
  ErrorsStreamingNotFoundHandler,
  ErrorsFlakyCacheHandler,
  ErrorsFlakyHealHandler,
  ErrorsFlakyPprHandler,
  ErrorsFlakyResetHandler,
  ErrorsSlotFailingHandler,
} from "./errors.handlers.js";

/**
 * Error test routes URL patterns
 * Routes: errors.index, errors.clientError, errors.serverError, errors.streamingError,
 * errors.streamingDeclared, errors.streamingDeclaredNoSsr, errors.streamingNotFound
 */
export const errorsPatterns = urls(
  ({
    path,
    layout,
    parallel,
    cache,
    loading,
    errorBoundary,
    notFoundBoundary,
  }) => [
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
    path(
      "/errors/streaming-declared",
      ErrorsStreamingDeclaredHandler,
      { name: "errors.streamingDeclared" },
      () => [
        loading(
          <div data-testid="streaming-declared-loading">
            <p>Loading streaming content...</p>
          </div>,
        ),
        errorBoundary(({ error }) => (
          <div data-testid="streaming-declared-fallback">
            <p>Declared streaming fallback</p>
            <p data-testid="streaming-declared-segment">{error.segmentType}</p>
          </div>
        )),
      ],
    ),
    path(
      "/errors/streaming-declared-no-ssr",
      ErrorsStreamingDeclaredNoSsrHandler,
      { name: "errors.streamingDeclaredNoSsr" },
      () => [
        loading(
          <div data-testid="streaming-declared-no-ssr-loading">
            <p>Loading streaming content...</p>
          </div>,
          { ssr: false },
        ),
        errorBoundary(() => (
          <div data-testid="streaming-declared-no-ssr-fallback">
            Declared streaming fallback (ssr: false)
          </div>
        )),
      ],
    ),
    path(
      "/errors/streaming-not-found",
      ErrorsStreamingNotFoundHandler,
      { name: "errors.streamingNotFound" },
      () => [
        loading(
          <div data-testid="streaming-not-found-loading">
            <p>Loading streaming content...</p>
          </div>,
        ),
        notFoundBoundary(() => (
          <div data-testid="streaming-not-found-fallback">
            Declared streaming notFound fallback
          </div>
        )),
      ],
    ),
    path.json("/errors/flaky/heal", ErrorsFlakyHealHandler, {
      name: "errors.flakyHeal",
    }),
    path.json("/errors/flaky/reset", ErrorsFlakyResetHandler, {
      name: "errors.flakyReset",
    }),
    // A failed streamed render must not be stored: the next request is healthy.
    cache({ ttl: 300 }, () => [
      path(
        "/errors/flaky-cache",
        ErrorsFlakyCacheHandler,
        { name: "errors.flakyCache" },
        () => [
          loading(<div data-testid="flaky-loading">Loading...</div>),
          errorBoundary(() => (
            <div data-testid="flaky-fallback">Declared flaky fallback</div>
          )),
        ],
      ),
    ]),
    path(
      "/errors/flaky-ppr",
      ErrorsFlakyPprHandler,
      { name: "errors.flakyPpr", ppr: true },
      () => [
        loading(<div data-testid="flaky-loading">Loading...</div>),
        errorBoundary(() => (
          <div data-testid="flaky-fallback">Declared flaky fallback</div>
        )),
      ],
    ),
    // A slot with loading() finds the boundary declared on its layout.
    layout(<SlotAncestorLayout />, () => [
      errorBoundary(() => (
        <div data-testid="slot-ancestor-fallback">Ancestor fallback</div>
      )),
      parallel({ "@side": ErrorsSlotFailingHandler }, () => [
        loading(<div data-testid="slot-ancestor-loading">Loading slot...</div>),
      ]),
      path(
        "/errors/slot-ancestor",
        () => <div data-testid="slot-ancestor-page">page</div>,
        {
          name: "errors.slotAncestor",
        },
      ),
    ]),
    path("/errors/rendering-error", ErrorsRenderingErrorHandler, {
      name: "errors.renderingError",
    }),
  ],
);
