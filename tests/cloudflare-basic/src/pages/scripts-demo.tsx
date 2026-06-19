import { Meta, Script } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";
import { Breadcrumbs } from "../handles/breadcrumbs.js";

/**
 * Exercises the built-in Script handle + <Scripts/> renderer under the Cloudflare
 * preset (router.fetch), which self-wires the request nonce. Pushes one inline
 * head script and one inline body script; each sets a window sentinel so the e2e
 * can prove they were rendered into the document and executed. The CSP nonce is
 * applied automatically by <Scripts/> (no nonce is passed here).
 */
export function ScriptsDemoPage(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "Scripts Demo - RSC Router Cloudflare" });

  const breadcrumb = ctx.use(Breadcrumbs);
  breadcrumb({ label: "Home", href: "/" });
  breadcrumb({ label: "Scripts", href: "/scripts-demo" });

  ctx.use(Script)({ id: "cf-head", children: "window.__cfHeadScript = true;" });
  ctx.use(Script)({
    id: "cf-body",
    position: "body",
    children: "window.__cfBodyScript = true;",
  });

  return (
    <main data-testid="scripts-demo-page">
      <h1 data-testid="scripts-demo-title">Scripts Demo</h1>
      <p>
        Inline scripts injected via <code>ctx.use(Script)</code> and rendered by{" "}
        <code>&lt;Scripts/&gt;</code> in the document head and body.
      </p>
    </main>
  );
}
