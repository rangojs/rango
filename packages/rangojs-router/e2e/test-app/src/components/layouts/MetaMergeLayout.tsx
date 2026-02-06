import { Meta } from "@rangojs/router/server";
import { Outlet, Link } from "@rangojs/router/client";

/**
 * Layout for testing meta merging
 */
export function MetaMergeLayout(ctx: any) {
  const meta = ctx.use(Meta);
  meta({ title: "Merge Root" });
  meta({ name: "author", content: "Root Author" });
  meta({ name: "keywords", content: "root, test" });
  meta({ property: "og:site_name", content: "Merge Test Site" });

  return (
    <div data-testid="meta-merge-layout">
      <nav data-testid="meta-merge-nav">
        <Link to="/meta-merge" data-testid="meta-merge-index-link">
          Merge Index
        </Link>
        <Link to="/meta-merge/child" data-testid="meta-merge-child-link">
          Merge Child
        </Link>
        <Link to="/meta-merge/deep/nested" data-testid="meta-merge-deep-link">
          Deep Nested
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}

/**
 * Middle layout that overrides author
 */
export function MetaMergeMiddleLayout(ctx: any) {
  const meta = ctx.use(Meta);
  // Middle layout overrides author
  meta({ name: "author", content: "Middle Author" });

  return (
    <div data-testid="meta-merge-middle-layout">
      <Outlet />
    </div>
  );
}
