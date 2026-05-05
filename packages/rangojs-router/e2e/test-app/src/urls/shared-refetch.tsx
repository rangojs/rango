import { urls, loader } from "@rangojs/router";
import {
  SharedRefetchLoader,
  SharedRefetchErrorLoader,
  SharedRefetchErrorMixedLoader,
} from "../loaders.js";
import { SharedRefetchLayout } from "../components/SharedRefetchLayout.js";
import { SharedRefetchPage } from "../components/SharedRefetchPage.js";
import { SharedRefetchSibling } from "../components/SharedRefetchSibling.js";
import { SharedRefetchParamWidget } from "../components/SharedRefetchParamWidget.js";
import { SharedRefetchErrorWidget } from "../components/SharedRefetchErrorWidget.js";

/**
 * Regression scenarios for the shared-loader subscription model.
 *
 * /shared-refetch              — three reads of the same loader; the
 *                                layout's load() must propagate to the
 *                                page and sibling.
 * /shared-refetch-params       — two parameterized fetches with different
 *                                params keep independent results.
 * /shared-refetch-error        — failing refetch with both readers using
 *                                throwOnError: true. The clicker throws,
 *                                the sibling exposes the same error
 *                                without throwing.
 * /shared-refetch-error-mixed  — same scenario but the clicker has
 *                                throwOnError: false (so it does NOT
 *                                throw despite calling load()), and the
 *                                sibling has throwOnError: true (so it
 *                                must NOT throw on someone else's
 *                                failure).
 */
export const sharedRefetchPatterns = urls(({ path, layout }) => [
  layout(SharedRefetchLayout, () => [
    path(
      "/shared-refetch",
      () => (
        <div data-testid="shared-refetch-page-root">
          <h1>Shared Refetch</h1>
          <SharedRefetchPage />
          <SharedRefetchSibling />
        </div>
      ),
      { name: "sharedRefetch" },
      () => [loader(SharedRefetchLoader)],
    ),
  ]),
  path(
    "/shared-refetch-params",
    () => (
      <div data-testid="shared-refetch-params-page">
        <h1>Shared Refetch — Params</h1>
        <SharedRefetchParamWidget id="A" tag="alpha" />
        <SharedRefetchParamWidget id="B" tag="beta" />
      </div>
    ),
    { name: "sharedRefetchParams" },
  ),
  path(
    "/shared-refetch-error",
    () => (
      <div data-testid="shared-refetch-error-page">
        <h1>Shared Refetch — Error</h1>
        <SharedRefetchErrorWidget id="A" withButton />
        <SharedRefetchErrorWidget id="B" withButton={false} />
      </div>
    ),
    { name: "sharedRefetchError" },
    () => [loader(SharedRefetchErrorLoader)],
  ),
  path(
    "/shared-refetch-error-mixed",
    () => (
      <div data-testid="shared-refetch-error-mixed-page">
        <h1>Shared Refetch — Mixed throwOnError</h1>
        <SharedRefetchErrorWidget
          id="A"
          withButton
          throwOnError={false}
          variant="mixed"
        />
        <SharedRefetchErrorWidget
          id="B"
          withButton={false}
          throwOnError
          variant="mixed"
        />
      </div>
    ),
    { name: "sharedRefetchErrorMixed" },
    () => [loader(SharedRefetchErrorMixedLoader)],
  ),
]);
