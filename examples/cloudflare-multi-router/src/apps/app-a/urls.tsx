import { urls } from "@rangojs/router";
import { AppALayout } from "./components/Layout.js";

export const appAPatterns = urls(({ path, layout }) => [
  layout(<AppALayout />, () => [
    path(
      "/app-a",
      () => (
        <main data-testid="app-a-home">
          <h1 data-testid="app-a-home-title">App A Home</h1>
        </main>
      ),
      { name: "home" },
    ),
    path(
      "/app-a/page",
      () => (
        <main data-testid="app-a-page">
          <h1 data-testid="app-a-page-title">App A Page</h1>
        </main>
      ),
      { name: "page" },
    ),
  ]),
]);
