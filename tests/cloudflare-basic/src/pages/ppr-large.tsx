import { Suspense, type ReactNode } from "react";
import { Meta, createLoader } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { PprLargeHole } from "../components/PprLargeHole.js";

// Large-shell fixture (issue #941): a storefront-sized PPR shell whose entry
// carries a ~650 KB prelude and a ~1 MB capture snapshot (the implicit doc
// record; the "use cache" reads that produced it are not recorded).
// Deterministic content, so every capture of a key produces the same bytes.

const PRODUCT_COUNT = 380;
const NAV_LINKS = 560;

interface LargeProduct {
  id: string;
  name: string;
  description: string;
  price: number;
  image: string;
  badges: string[];
  attributes: Record<string, string>;
  cms: { blocks: { type: string; text: string }[]; revision: number };
}

// Seeded pseudo-random words over a large synthetic vocabulary, so the page
// compresses like real copy (~5x) instead of a repeated word list.
const SYLLABLES =
  "ka lo mi ne su ta ri vo pe da gu zi fa mo che lin ber sto qua nex".split(
    " ",
  );

function nextSeed(state: number): number {
  return (Math.imul(state ^ (state >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
}

function words(seed: number, count: number): string {
  let state = nextSeed(seed + 1);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let word = "";
    const len = 2 + (state % 3);
    for (let s = 0; s < len; s++) {
      state = nextSeed(state);
      word += SYLLABLES[state % SYLLABLES.length];
    }
    out.push(word);
    state = nextSeed(state);
  }
  return out.join(" ");
}

function makeProduct(i: number): LargeProduct {
  return {
    id: `sku-${i}`,
    name: `Product ${i} ${words(i, 3)}`,
    description: words(i, 60),
    price: 1000 + ((i * 37) % 9000),
    image: `https://images.example.com/catalog/sku-${i}/main-800x1000.webp`,
    badges: i % 3 === 0 ? ["new", "limited"] : ["bestseller"],
    attributes: {
      color: words(i, 1),
      material: words(i + 1, 2),
      fit: words(i + 2, 1),
      care: words(i + 3, 8),
    },
    cms: {
      blocks: [
        { type: "rich-text", text: words(i + 4, 40) },
        { type: "rich-text", text: words(i + 5, 40) },
      ],
      revision: i,
    },
  };
}

// Raw CMS lookup: returns more than the page renders (the cms blocks), like a
// real CMS payload.
export async function getPprLargeCatalog(
  slug: string,
): Promise<LargeProduct[]> {
  "use cache";
  const products: LargeProduct[] = [];
  for (let i = 0; i < PRODUCT_COUNT; i++) products.push(makeProduct(i));
  void slug;
  return products;
}

async function renderPprLargeBody(slug: string): Promise<ReactNode> {
  "use cache";
  const products = await getPprLargeCatalog(slug);
  return (
    <section data-testid="ppr-large-body" className="grid">
      {products.map((p) => (
        <article key={p.id} className="card" data-sku={p.id}>
          <img src={p.image} alt={p.name} width={800} height={1000} />
          <h2 className="card-title">{p.name}</h2>
          <p className="card-price">{(p.price / 100).toFixed(2)} EUR</p>
          <ul className="card-badges">
            {p.badges.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <p className="card-description">{p.description}</p>
          <dl className="card-attributes">
            {Object.entries(p.attributes).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </article>
      ))}
    </section>
  );
}

async function renderPprLargeChrome(part: string): Promise<ReactNode> {
  "use cache";
  const links: ReactNode[] = [];
  for (let i = 0; i < NAV_LINKS; i++) {
    links.push(
      <li key={i}>
        <a href={`/${part}/category-${i}/${words(i, 2).replace(/ /g, "-")}`}>
          {part} {words(i, 2)}
        </a>
      </li>,
    );
  }
  return (
    <nav data-testid={`ppr-large-${part}`} className={`chrome-${part}`}>
      <ul>{links}</ul>
    </nav>
  );
}

export async function PprLargeLayout(ctx: HandlerContext) {
  ctx.use(Meta)({ title: "PPR Large - RSC Router Cloudflare" });
  const [header, nav, footer] = await Promise.all([
    renderPprLargeChrome("header"),
    renderPprLargeChrome("nav"),
    renderPprLargeChrome("footer"),
  ]);
  return (
    <main data-testid="ppr-large-page">
      {header}
      {nav}
      <Outlet />
      {footer}
    </main>
  );
}

export async function PprLargePage(ctx: HandlerContext) {
  // The handler reads the raw catalog itself (a recorded item the doc record
  // covers), then renders the cached body component.
  const catalog = await getPprLargeCatalog(ctx.pathname);
  return (
    <>
      <p data-testid="ppr-large-count">{catalog.length} products</p>
      {await renderPprLargeBody(ctx.pathname)}
    </>
  );
}

let pprLargeHoleSeq = 0;

export const PprLargeHoleLoader = createLoader(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  pprLargeHoleSeq += 1;
  return { seq: pprLargeHoleSeq };
});

// Holes variant: the same body plus a live loader read under an inline
// <Suspense>, so the capture postpones there and the entry carries a
// postponed blob.
export async function PprLargeHolesPage(ctx: HandlerContext) {
  const catalog = await getPprLargeCatalog(ctx.pathname);
  const body = await renderPprLargeBody(ctx.pathname);
  return (
    <>
      <p data-testid="ppr-large-count">{catalog.length} products</p>
      {body}
      <Suspense
        fallback={<div data-testid="ppr-large-hole-fallback">Loading...</div>}
      >
        <PprLargeHole loader={PprLargeHoleLoader} />
      </Suspense>
    </>
  );
}
