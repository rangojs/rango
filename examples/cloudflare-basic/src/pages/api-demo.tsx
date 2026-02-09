import type { HandlerContext } from "@rangojs/router";
import { Breadcrumbs } from "../handles/breadcrumbs.js";
import { ApiDataDemo } from "../components/ApiDataDemo.js";

export function ApiDemoPage(ctx: HandlerContext) {
  const breadcrumb = ctx.use(Breadcrumbs);
  breadcrumb({ label: "Home", href: "/" });
  breadcrumb({ label: "API Demo", href: "/api-demo" });

  return (
    <main data-testid="api-demo-page">
      <h1 data-testid="api-demo-title">API Data Demo</h1>
      <p>Type-safe client-side fetch using PathResponse and href()</p>
      <ApiDataDemo />
    </main>
  );
}
