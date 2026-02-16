import { urls } from "@rangojs/router";
import {
  ClientThemeLoader,
  IsomorphicCartLoader,
  ServerOnlyTestLoader,
} from "../client-loaders.js";
import { IsolatedIsomorphicLoader } from "../isolated-isomorphic-loader.js";
import {
  ClientLoaderHandler,
  IsomorphicLoaderHandler,
  IsomorphicSsrHandler,
  IsolatedIsomorphicHandler,
  MixedLoaderHandler,
} from "./client-loader.handlers.js";

/**
 * URL patterns for testing client and isomorphic loaders.
 *
 * Routes:
 *  - /client-loader        : Client-only loader (shows loading on SSR, resolves on client)
 *  - /isomorphic-loader    : Isomorphic loader (SSR uses server fn)
 *  - /isomorphic-ssr       : Isomorphic loader SSR-only test (direct navigation)
 *  - /mixed-loader         : Server loader + client loader on the same route
 *  - /isolated-isomorphic  : Isomorphic loader in export-only file
 */
export const clientLoaderPatterns = urls(
  ({ path, loader, loading }) => [
    path(
      "/client-loader",
      ClientLoaderHandler,
      { name: "clientLoader" },
      () => [
        loader(ClientThemeLoader),
        loading(
          <div data-testid="client-loader-loading">
            <p>Loading theme...</p>
          </div>,
        ),
      ],
    ),

    path(
      "/isomorphic-loader",
      IsomorphicLoaderHandler,
      { name: "isomorphicLoader" },
      () => [
        loader(IsomorphicCartLoader),
        loading(
          <div data-testid="isomorphic-loader-loading">
            <p>Loading cart...</p>
          </div>,
        ),
      ],
    ),

    path(
      "/isomorphic-ssr",
      IsomorphicSsrHandler,
      { name: "isomorphicSsr" },
      () => [
        loader(IsomorphicCartLoader),
      ],
    ),

    path(
      "/mixed-loader",
      MixedLoaderHandler,
      { name: "mixedLoader" },
      () => [
        loader(ServerOnlyTestLoader),
        loader(ClientThemeLoader),
        loading(
          <div data-testid="mixed-loader-loading">
            <p>Loading mixed data...</p>
          </div>,
        ),
      ],
    ),

    path(
      "/isolated-isomorphic",
      IsolatedIsomorphicHandler,
      { name: "isolatedIsomorphic" },
      () => [
        loader(IsolatedIsomorphicLoader),
        loading(
          <div data-testid="isolated-isomorphic-loading">
            <p>Loading isolated data...</p>
          </div>,
        ),
      ],
    ),
  ],
);
