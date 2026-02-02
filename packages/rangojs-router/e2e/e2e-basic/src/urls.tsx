import { urls } from "@rangojs/router";
import { AppLayout } from "./components/layouts/index.js";
import { HomePage, AboutPage } from "./components/pages/index.js";
import { blogPatterns } from "./urls/blog.js";
import { shopPatterns } from "./urls/shop.js";

/**
 * Main URL patterns - Django-style routing API
 */
export const urlpatterns = urls(({ path, layout, include }) => [
  layout(AppLayout, () => [
    path("/", HomePage, { name: "home" }),
    path("/about", AboutPage, { name: "about" }),
    include("/blog", blogPatterns, { name: "blog" }),
    include("/shop", shopPatterns, { name: "shop" }),
  ]),
]);
