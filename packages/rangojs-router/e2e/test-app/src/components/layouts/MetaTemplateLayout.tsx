import { Meta } from "@rangojs/router";
import { Outlet, Link } from "@rangojs/router/client";

/**
 * Layout with title template - sets template for child routes
 */
export function MetaTemplateLayout(ctx: any) {
  const meta = ctx.use(Meta);
  // Set title template - child routes will have their title wrapped
  meta({ title: { template: "%s | Test Site", default: "Test Site" } });
  meta({ name: "author", content: "Test Author" });

  return (
    <div data-testid="meta-template-layout">
      <nav data-testid="meta-template-nav">
        <Link to="/meta-template" data-testid="meta-template-index-link">
          Template Index
        </Link>
        <Link to="/meta-template/child" data-testid="meta-template-child-link">
          Child
        </Link>
        <Link
          to="/meta-template/absolute"
          data-testid="meta-template-absolute-link"
        >
          Absolute
        </Link>
        <Link
          to="/meta-template/nested"
          data-testid="meta-template-nested-link"
        >
          Nested
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}

/**
 * Nested layout with its own template - overrides parent template
 */
export function MetaTemplateNestedLayout(ctx: any) {
  const meta = ctx.use(Meta);
  // Override parent template with new one
  meta({
    title: { template: "%s | Nested Section", default: "Nested Section" },
  });

  return (
    <div data-testid="meta-template-nested-layout">
      <Outlet />
    </div>
  );
}
