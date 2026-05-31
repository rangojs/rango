import { createRouter } from "@rangojs/router";
import { AppLayout } from "./components/AppLayout.jsx";
import { HomePage } from "./pages/home.jsx";
import { AboutPage } from "./pages/about.jsx";
import { CounterPage } from "./pages/counter.jsx";
import { DashboardPage } from "./pages/dashboard.jsx";
import { FetchPage } from "./pages/fetch.jsx";
import { FlashPage } from "./pages/flash.jsx";
import { FeatureDetailPage } from "./pages/features.jsx";
import { FeatureLoading } from "./components/FeatureLoading.jsx";
import { DashboardLoader } from "./loaders.js";
import { blogPatterns } from "./blog/urls.jsx";

// This app is written entirely in plain JavaScript (no .ts/.tsx, no tsconfig)
// to verify @rangojs/router works end to end without TypeScript. It exercises
// the full feature surface at a smoke level: routing, layouts, include()
// composition, server actions, loaders, fetchable loaders, handles, location
// state (navigation-set and action-set), and revalidation.
export const router = createRouter().routes(
  ({ path, layout, include, loader, loading, revalidate, transition }) => [
    layout(AppLayout, () => [
      path("/", HomePage, { name: "home" }),
      path("/about", AboutPage, { name: "about" }),

      // Server actions: an in-memory counter mutated by "use server" functions.
      path("/counter", CounterPage, { name: "counter" }),

      // Loaders + revalidation: DashboardLoader runs fresh on load and re-runs
      // after any action (the revalidate predicate matches when actionId is
      // set), so useLoader reflects the new value without a navigation.
      path("/dashboard", DashboardPage, { name: "dashboard" }, () => [
        loader(DashboardLoader),
        revalidate(({ actionId }) => !!actionId),
      ]),

      // Fetchable loader: fetched on demand from the client via useFetchLoader.
      path("/fetch", FetchPage, { name: "fetch" }),

      // Action-set location state: a "use server" action writes location state
      // that reaches the client through the action response.
      path("/flash", FlashPage, { name: "flash" }),

      // Handles + navigation-set location state + loading fallback: the feature
      // handler pushes breadcrumb items via ctx.use(Breadcrumbs); the loading
      // fallback reads the location state passed on the originating Link.
      // transition() opts same-route (feature -> feature) navigation into
      // stale-while-revalidate, holding current content instead of flashing the
      // skeleton; cross-route navs still remount and show it.
      path("/features/:slug", FeatureDetailPage, { name: "feature" }, () => [
        loading(<FeatureLoading />),
        transition(),
      ]),

      // include(): composes a separate URL module mounted under /blog.
      include("/blog", blogPatterns, { name: "blog" }),
    ]),
  ],
);
