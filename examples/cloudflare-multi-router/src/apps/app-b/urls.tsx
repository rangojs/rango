import { urls } from "@rangojs/router";
import { AppBLayout } from "./components/Layout.js";

export const appBPatterns = urls(({ path, layout }) => [
  layout(<AppBLayout />, () => [
    path(
      "/app-b",
      () => (
        <main data-testid="app-b-home">
          <h1 data-testid="app-b-home-title">App B Home</h1>
        </main>
      ),
      { name: "home" },
    ),
    path(
      "/app-b/page",
      () => (
        <main data-testid="app-b-page">
          <h1 data-testid="app-b-page-title">App B Page</h1>
        </main>
      ),
      { name: "page" },
    ),
  ]),
]);
