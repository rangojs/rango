import type { Handler } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { IsomorphicCartLoader } from "../client-loaders.js";
import {
  ClientThemeContent,
  IsomorphicCartContent,
  IsolatedIsomorphicContent,
  MixedLoaderContent,
} from "../components/ClientLoaderContent.js";

/**
 * Handler for client-only loader route.
 * During SSR, the client loader is not executed so the loading skeleton shows.
 * After hydration, the client loader resolves and useLoader gets the data.
 */
export const ClientLoaderHandler: Handler<"clientLoader"> = () => {
  return (
    <div data-testid="client-loader-page">
      <Link to="/" data-testid="back-link">
        Back to Home
      </Link>
      <h1 data-testid="client-loader-title">Client Loader Test</h1>
      <ClientThemeContent />
    </div>
  );
};

/**
 * Handler for isomorphic loader route.
 * During SSR, the server fn runs. During SPA navigation, the client fn runs.
 */
export const IsomorphicLoaderHandler: Handler<"isomorphicLoader"> = () => {
  return (
    <div data-testid="isomorphic-loader-page">
      <Link to="/" data-testid="back-link">
        Back to Home
      </Link>
      <h1 data-testid="isomorphic-loader-title">Isomorphic Loader Test</h1>
      <IsomorphicCartContent />
    </div>
  );
};

/**
 * Handler for isomorphic SSR test - uses ctx.use() directly on server.
 * This verifies the server fn executes during SSR document requests.
 */
export const IsomorphicSsrHandler: Handler<"isomorphicSsr"> = async (ctx) => {
  const data = await ctx.use(IsomorphicCartLoader);
  return (
    <div data-testid="isomorphic-ssr-page">
      <Link to="/" data-testid="back-link">
        Back to Home
      </Link>
      <h1 data-testid="isomorphic-ssr-title">Isomorphic SSR Test</h1>
      <p data-testid="isomorphic-ssr-source">Source: {data.source}</p>
      <p data-testid="isomorphic-ssr-total">Total: {data.total}</p>
      <p data-testid="isomorphic-ssr-items">
        Items: {data.items.join(", ")}
      </p>
    </div>
  );
};

/**
 * Handler for isolated isomorphic loader test.
 * The loader lives in its own export-only file, testing that the Vite plugin
 * does not stub the client fn registration for such files.
 */
export const IsolatedIsomorphicHandler: Handler<"isolatedIsomorphic"> = () => {
  return (
    <div data-testid="isolated-isomorphic-page">
      <Link to="/" data-testid="back-link">
        Back to Home
      </Link>
      <h1 data-testid="isolated-isomorphic-title">Isolated Isomorphic Test</h1>
      <IsolatedIsomorphicContent />
    </div>
  );
};

/**
 * Handler for mixed loader route (server + client loaders on same route).
 */
export const MixedLoaderHandler: Handler<"mixedLoader"> = () => {
  return (
    <div data-testid="mixed-loader-page">
      <Link to="/" data-testid="back-link">
        Back to Home
      </Link>
      <h1 data-testid="mixed-loader-title">Mixed Loader Test</h1>
      <MixedLoaderContent />
    </div>
  );
};
