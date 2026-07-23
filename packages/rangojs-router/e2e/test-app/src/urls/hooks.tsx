import { urls } from "@rangojs/router";
import {
  HookTestLoader,
  HookTestLoaderB,
  PeHeaderProbeLoader,
} from "../loaders.js";
import {
  FetchLoaderHandler,
  HookTestsIndexHandler,
  HookTestsRouteAHandler,
  HookTestsRouteBHandler,
  HookTestsNoLoaderHandler,
  HookTestsFormActionHandler,
  LoaderCompositionHandler,
  InlineActionHandler,
  InlineBoundActionHandler,
  InlineBoundPageHoleLoader,
  ProgressiveEnhancementHandler,
  ParityCounterHandler,
  PeRedirectHandler,
  MetaEscapeHandler,
  PeHeaderHandler,
  UseRouterHandler,
  UseRouterTargetAHandler,
  UseRouterTargetBHandler,
  UrlHooksHandler,
  UrlHooksNestedHandler,
} from "./hooks.handlers.js";

/**
 * Hook test routes URL patterns
 * Routes: fetchLoader, hookTests.*, loaderComposition, inlineAction, progressiveEnhancement
 */
export const hooksPatterns = urls(({ path, loader }) => [
  // JSON-LD breakout-escaping fixture: meta emits a script:ld+json descriptor
  // whose string field contains a literal </script>.
  path("/meta-escape", MetaEscapeHandler, { name: "metaEscape" }),
  // Progressive-enhancement header-preservation fixture: action form + loader
  // that reads the pe-probe request cookie during the (no-JS) re-render.
  path("/pe-header", PeHeaderHandler, { name: "peHeader" }, () => [
    loader(PeHeaderProbeLoader),
  ]),
  path("/fetch-loader", FetchLoaderHandler, { name: "fetchLoader" }),
  path("/hook-tests", HookTestsIndexHandler, { name: "hookTests.index" }),
  path(
    "/hook-tests/route-a",
    HookTestsRouteAHandler,
    { name: "hookTests.routeA" },
    () => [loader(HookTestLoader)],
  ),
  path(
    "/hook-tests/route-b",
    HookTestsRouteBHandler,
    { name: "hookTests.routeB" },
    () => [loader(HookTestLoaderB)],
  ),
  path("/hook-tests/no-loader", HookTestsNoLoaderHandler, {
    name: "hookTests.noLoader",
  }),
  path("/hook-tests/form-action", HookTestsFormActionHandler, {
    name: "hookTests.formAction",
  }),
  path("/loader-composition", LoaderCompositionHandler, {
    name: "loaderComposition",
  }),
  path("/inline-action", InlineActionHandler, { name: "inlineAction" }),
  path(
    "/inline-bound-action",
    InlineBoundActionHandler,
    {
      name: "inlineBoundAction",
      ppr: true,
    },
    () => [loader(InlineBoundPageHoleLoader)],
  ),
  path("/progressive-enhancement", ProgressiveEnhancementHandler, {
    name: "progressiveEnhancement",
  }),
  path("/parity-counter", ParityCounterHandler, {
    name: "parityCounter",
  }),
  path("/pe-redirect", PeRedirectHandler, {
    name: "peRedirect",
  }),

  // useRouter hook test routes
  path(
    "/hook-tests/use-router",
    UseRouterHandler,
    { name: "hookTests.useRouter" },
    () => [loader(HookTestLoader)],
  ),
  path(
    "/hook-tests/use-router/target-a",
    UseRouterTargetAHandler,
    { name: "hookTests.useRouterTargetA" },
    () => [loader(HookTestLoader)],
  ),
  path(
    "/hook-tests/use-router/target-b",
    UseRouterTargetBHandler,
    { name: "hookTests.useRouterTargetB" },
    () => [loader(HookTestLoaderB)],
  ),

  // URL hooks test routes (useParams, usePathname, useSearchParams)
  path("/hook-tests/url-hooks/:slug", UrlHooksHandler, {
    name: "hookTests.urlHooks",
  }),
  path("/hook-tests/url-hooks/:slug/:id", UrlHooksNestedHandler, {
    name: "hookTests.urlHooksNested",
  }),
]);
