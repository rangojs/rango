import { urls } from "@rangojs/router";
import { Meta, type HandlerContext } from "@rangojs/router";
import { SiteLayout } from "./components/Layout.js";

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

export const sitePatterns = urls(({ path, layout }) => [
  layout(<SiteLayout />, () => [
    path("/", HomePage, { name: "home" }),
    path("/about", AboutPage, { name: "about" }),
  ]),
]);
