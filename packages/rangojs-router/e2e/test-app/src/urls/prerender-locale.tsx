import { urls, Prerender, Passthrough } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";

// Prerender handler mounted under a parameterized include() prefix.
// Tests that getParams must return ALL params (parent locale + child slug)
// for the full URL pattern to resolve at build time.

const LOCALES = ["en", "fr"];
const SLUGS = ["hello", "world"];

// Named route resolves full params from GeneratedRouteMap:
//   "locale.detail" -> "/:locale/blog/:slug" -> { locale: string; slug: string }
// No casts needed — both locale and slug are fully typed.
export const PrerenderLocaleDef = Prerender<"locale.detail">(
  async () => {
    // getParams returns cross-product of locale x slug.
    // Fully typed: TS enforces both locale and slug are present.
    const params: { locale: string; slug: string }[] = [];
    for (const locale of LOCALES) {
      for (const slug of SLUGS) {
        params.push({ locale, slug });
      }
    }
    return params;
  },
  async (ctx) => {
    // ctx.params is { locale: string; slug: string } — no cast needed
    const content = `content-${ctx.params.locale}-${ctx.params.slug}`;
    ctx.set("localeContent", content);
    // Test reverse auto-fill: locale should be inherited from ctx.params
    const listUrl = ctx.reverse(".list");
    return (
      <div data-testid="locale-detail-page">
        <h1 data-testid="locale-detail-title">{ctx.params.slug}</h1>
        <p data-testid="locale-detail-locale">{ctx.params.locale}</p>
        <p data-testid="locale-detail-content">{content}</p>
        <p data-testid="locale-detail-build">{String(ctx.build)}</p>
        <p data-testid="locale-detail-timestamp">{Date.now()}</p>
        <p data-testid="locale-detail-list-url">{listUrl}</p>
      </div>
    );
  },
  { concurrency: 2 },
);

// Passthrough wraps the build-time definition with a live handler for
// unknown locale+slug combos not covered by getParams.
export const PrerenderLocaleDetail = Passthrough(
  PrerenderLocaleDef,
  async (ctx) => {
    const content = `content-${ctx.params.locale}-${ctx.params.slug}`;
    ctx.set("localeContent", content);
    const listUrl = ctx.reverse(".list");
    return (
      <div data-testid="locale-detail-page">
        <h1 data-testid="locale-detail-title">{ctx.params.slug}</h1>
        <p data-testid="locale-detail-locale">{ctx.params.locale}</p>
        <p data-testid="locale-detail-content">{content}</p>
        <p data-testid="locale-detail-build">{String(ctx.build)}</p>
        <p data-testid="locale-detail-timestamp">{Date.now()}</p>
        <p data-testid="locale-detail-list-url">{listUrl}</p>
      </div>
    );
  },
);

// Orphan layout reads handler data via ctx.get()
function PrerenderLocaleLayout(ctx: any) {
  const localeContent = ctx.get("localeContent");
  return (
    <div data-testid="locale-layout">
      <p data-testid="locale-layout-content">{localeContent ?? "undefined"}</p>
      <Outlet />
    </div>
  );
}

// Static list handler (non-prerender) to test reverse() target
function LocaleList(ctx: any) {
  return (
    <div data-testid="locale-list-page">
      <h1 data-testid="locale-list-title">Blog list for {ctx.params.locale}</h1>
    </div>
  );
}

export const prerenderLocalePatterns = urls(({ path, layout }) => [
  path("/blog/:slug", PrerenderLocaleDetail, { name: "detail" }, () => [
    layout(PrerenderLocaleLayout),
  ]),
  path("/blog", LocaleList, { name: "list" }),
]);
