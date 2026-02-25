import { urls, Prerender } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";

// Prerender handler mounted under a parameterized include() prefix.
// Tests that getParams must return ALL params (parent locale + child slug)
// for the full URL pattern to resolve at build time.

const LOCALES = ["en", "fr"];
const SLUGS = ["hello", "world"];

// Prerender generic only declares the route's own params (slug).
// The locale param comes from the parent include() prefix and is
// available at runtime via ctx.params but not typed on the path pattern.
export const PrerenderLocaleDetail = Prerender<{ slug: string }>(
  async () => {
    // getParams must return cross-product of locale x slug
    // because the full pattern is /:locale/blog/:slug
    const params: { locale: string; slug: string }[] = [];
    for (const locale of LOCALES) {
      for (const slug of SLUGS) {
        params.push({ locale, slug });
      }
    }
    return params;
  },
  async (ctx) => {
    // locale comes from parent include() prefix, cast to access it
    const params = ctx.params as Record<string, string>;
    const content = `content-${params.locale}-${params.slug}`;
    ctx.set("localeContent", content);
    // Test reverse auto-fill: locale should be inherited from ctx.params
    const listUrl = ctx.reverse(".list");
    return (
      <div data-testid="locale-detail-page">
        <h1 data-testid="locale-detail-title">{params.slug}</h1>
        <p data-testid="locale-detail-locale">{params.locale}</p>
        <p data-testid="locale-detail-content">{content}</p>
        <p data-testid="locale-detail-build">{String(ctx.build)}</p>
        <p data-testid="locale-detail-timestamp">{Date.now()}</p>
        <p data-testid="locale-detail-list-url">{listUrl}</p>
      </div>
    );
  },
  { passthrough: true, concurrency: 2 },
);

// Orphan layout reads handler data via ctx.get()
function PrerenderLocaleLayout(ctx: any) {
  const localeContent = ctx.get("localeContent");
  return (
    <div data-testid="locale-layout">
      <p data-testid="locale-layout-content">
        {localeContent ?? "undefined"}
      </p>
      <Outlet />
    </div>
  );
}

// Static list handler (non-prerender) to test reverse() target
function LocaleList(ctx: any) {
  return (
    <div data-testid="locale-list-page">
      <h1 data-testid="locale-list-title">
        Blog list for {ctx.params.locale}
      </h1>
    </div>
  );
}

export const prerenderLocalePatterns = urls(({ path, layout }) => [
  path("/blog/:slug", PrerenderLocaleDetail, { name: "detail" }, () => [
    layout(PrerenderLocaleLayout),
  ]),
  path("/blog", LocaleList, { name: "list" }),
]);
