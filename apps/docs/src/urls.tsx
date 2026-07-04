import { urls } from "@rangojs/router";

import { DocsNav } from "./docs-sidebar";
import { DocsIndexPage, DocsPage } from "./routes/docs";
import { HomePage } from "./routes/home";
import { agents, llms, mcp, robots, rss, sitemap } from "./routes/machine";
import { RootLayout } from "./routes/root-layout";

// Every page is static shared content, so serve each from a cached PPR shell.
// Shells auto-invalidate per deploy (deployment-namespaced store) and in dev
// whenever an edit re-executes the module graph.
const ppr = { ttl: 3600, swr: 86_400 };

export const urlpatterns = urls(({ layout, parallel, path }) => [
  layout(RootLayout, () => [
    path("/", HomePage, { name: "home", ppr }),
    // The left-hand pages nav is a Static segment (rendered once at build
    // time, shared by every docs page) mounted on the @docsNav slot.
    path("/docs", DocsIndexPage, { name: "docsIndex", ppr }, () => [
      parallel({ "@docsNav": DocsNav }),
    ]),
    path("/docs/*", DocsPage, { name: "docs", ppr }, () => [
      parallel({ "@docsNav": DocsNav }),
    ]),
  ]),

  // Machine / SEO routes (no chrome)
  path.text("/llms.txt", llms, { name: "llms" }),
  path.text("/robots.txt", robots, { name: "robots" }),
  path.xml("/sitemap.xml", sitemap, { name: "sitemap" }),
  path.any("/rss.xml", rss, { name: "rss" }),
  path.text("/agents.md", agents, { name: "agents" }),
  path.json("/.well-known/mcp.json", mcp, { name: "mcp" }),
]);
