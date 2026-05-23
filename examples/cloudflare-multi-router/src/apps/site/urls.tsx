import { urls } from "@rangojs/router";
import { Meta, type HandlerContext } from "@rangojs/router";
import { SiteLayout } from "./components/Layout.js";
import { siteApiPatterns } from "./api.js";
// #506 regression: nested lazy-include chain under a dynamic-param prefix.
import { groupPatterns } from "./nested-include.js";

function HomePage(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "Home - Site" });

  return (
    <main data-testid="site-home-page">
      <h1 data-testid="site-home-title">Welcome to the Site</h1>
      <p>This is the main site running on localhost.</p>
    </main>
  );
}

function AboutPage(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "About - Site" });

  return (
    <main data-testid="site-about-page">
      <h1 data-testid="site-about-title">About</h1>
      <p>This is the about page of the main site.</p>
    </main>
  );
}

export const sitePatterns = urls(({ path, layout, include }) => [
  layout(<SiteLayout />, () => [
    path("/", HomePage, { name: "home" }),
    path("/about", AboutPage, { name: "about" }),
    include("/api", siteApiPatterns, { name: "api" }),
    // #506: nested lazy-include chain group -> section -> item -> leaf.
    // group.index at /g/:id, group.section.item.leaf at /g/:id/sub/leaf.
    include("/g", groupPatterns, { name: "group" }),
  ]),
]);
