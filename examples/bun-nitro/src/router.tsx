import { createRouter, urls } from "@rangojs/router";
import { RootLayout } from "./layouts/RootLayout.js";
import { HomePage } from "./pages/home.js";
import { AboutPage } from "./pages/about.js";

const urlpatterns = urls(({ path }) => [
  path("/", HomePage, { name: "home" }),
  path("/about", AboutPage, { name: "about" }),
]);

const router = createRouter({
  document: RootLayout,
}).routes(urlpatterns);

type AppRoutes = typeof router.routeMap;

declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
  }
}

export { router };
