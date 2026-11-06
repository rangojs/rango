import { urls } from "@rangojs/router";
import { ParallelOutlet } from "@rangojs/router/client";
import {
  DocsNavLayout,
  DocsIndexPage,
  DocsNestedLayout,
  DocsNestedPage,
  DocsSpreadPage,
  DocsTocSidebar,
} from "./static-content.js";

// Dynamic page handler: runs at request time (not static)
function DocsPage(ctx: { params: { slug: string } }) {
  return (
    <div data-testid="docs-page" style={{ display: "flex", gap: "2rem" }}>
      <div style={{ flex: 1 }}>
        <h2 data-testid="docs-page-title">Doc: {ctx.params.slug}</h2>
        <p
          data-testid="docs-page-rendered-at"
          style={{ fontSize: "0.75rem", color: "#999" }}
        >
          Page rendered at: {new Date().toISOString()}
        </p>
      </div>
      <ParallelOutlet name="@toc" />
    </div>
  );
}

// A nested module with its own "docsPage": the nested Static layout's
// dot-local `.docsPage` must resolve here, not in the parent module.
const nestedPatterns = urls(({ path, layout }) => [
  layout(DocsNestedLayout, () => [
    path("/:slug", DocsNestedPage, { name: "docsPage" }),
  ]),
]);

export const staticContentPatterns = urls(
  ({ path, layout, parallel, include }) => [
    // Static layout wraps all docs routes -- rendered once at build time
    layout(DocsNavLayout, () => [
      // Static index page -- also rendered at build time (on path())
      path("/", DocsIndexPage, { name: "index" }),
      // Static route that copies its ctx at build time; before the dynamic
      // "/:slug" so the literal path wins.
      path("/spread", DocsSpreadPage, { name: "spread" }),
      // Dynamic page -- rendered at request time, with static parallel @toc sidebar
      path("/:slug", DocsPage, { name: "docsPage" }, () => [
        // Static parallel slot -- TOC sidebar rendered once at build time
        parallel({ "@toc": DocsTocSidebar }),
      ]),
      include("/nested", nestedPatterns, { name: "nested" }),
    ]),
  ],
);
