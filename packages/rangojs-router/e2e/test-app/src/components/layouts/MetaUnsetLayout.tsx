import { Meta } from "@rangojs/router";
import { Outlet, Link } from "@rangojs/router/client";

/**
 * Layout that sets meta to be unset by children
 */
export function MetaUnsetLayout(ctx: any) {
  const meta = ctx.use(Meta);
  meta({ title: "Parent Title" });
  meta({ name: "robots", content: "index, follow" });
  meta({ name: "description", content: "Parent description" });
  meta({ property: "og:image", content: "https://example.com/parent.jpg" });

  return (
    <div data-testid="meta-unset-layout">
      <nav data-testid="meta-unset-nav">
        <Link to="/meta-unset" data-testid="meta-unset-index-link">
          Unset Index
        </Link>
        <Link to="/meta-unset/child" data-testid="meta-unset-child-link">
          Unset Child
        </Link>
        <Link
          to="/meta-unset/unset-then-set"
          data-testid="meta-unset-then-set-link"
        >
          Unset Then Set
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}
