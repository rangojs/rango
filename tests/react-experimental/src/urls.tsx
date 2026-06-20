import { urls, Static, Prerender, Script } from "@rangojs/router";
import { Meta } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";
import { Link, href, Outlet } from "@rangojs/router/client";
import { DEFAULT_GTM_ID, generateGtmInit } from "./gtm/gtm.js";
import { Counter } from "./components/Counter.js";
import { Comments } from "./components/Comments.js";
import { getCounter } from "./actions/counter.js";
import { CommentsLoader } from "./loaders/comments.js";
import { SwrProductLoader } from "./loaders/swr-product.js";
import { SwrProductCounter } from "./components/SwrProductCounter.js";
import { ViewTransition } from "react";
import { ARTICLES } from "./data/articles.js";
import {
  RevenueLoader,
  ProductLoader,
  ActiveUsersLoader,
  OpenOrdersLoader,
  LatencyLoader,
} from "./loaders/metrics.js";
import {
  VtSharedKeyCard,
  VtProductCard,
  VtGroupCard,
  VtGroupRefreshButton,
} from "./components/RefreshDemo.js";

function HomePage(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "Home - React Experimental" });
  meta({
    name: "description",
    content: "RSC Router example with experimental React",
  });

  return (
    <main data-testid="home-page">
      <h1 data-testid="home-title">Welcome to RSC Router</h1>
      <p>
        This example tests compatibility with React's experimental release
        channel.
      </p>
    </main>
  );
}

function AboutPage(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "About - React Experimental" });
  meta({
    name: "description",
    content: "About the React experimental example",
  });

  return (
    <main data-testid="about-page">
      <h1 data-testid="about-title">About</h1>
      <p>
        This minimal example exercises RSC rendering, hydration, client
        components, and server actions using experimental React.
      </p>
    </main>
  );
}

async function CounterPage(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "Counter - React Experimental" });
  meta({
    name: "description",
    content: "Interactive counter with Server Actions",
  });

  const initialCount = await getCounter();

  return (
    <main data-testid="counter-page">
      <h1 data-testid="counter-title">Counter Demo</h1>
      <Counter initialCount={initialCount} />
    </main>
  );
}

// Client refresh + view-transition demo. A keyed refresh and a refreshGroup
// refresh both commit inside startTransition, so each card's value cross-fades
// via <ViewTransition> — in place, with no navigation.
function RefreshDemoPage(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "Refresh - View Transitions" });

  return (
    <main data-testid="refresh-demo-page">
      <h1 style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>
        Client Refresh + View Transitions
      </h1>
      <p style={{ color: "#6b7280", marginBottom: "1.5rem", maxWidth: 640 }}>
        A keyed refresh and a <code>refreshGroup</code> refresh both commit
        inside <code>startTransition</code>, so each card&apos;s value
        cross-fades through a <code>&lt;ViewTransition&gt;</code> — no
        navigation.
      </p>

      <h2 style={{ fontSize: "1.1rem", color: "#6b7280" }}>Shared key</h2>
      <p style={{ color: "#6b7280", margin: "0.25rem 0 0", maxWidth: 640 }}>
        Three cards read one loader with <code>key="revenue"</code>. A{" "}
        <code>load()</code> from any one is a single server fetch that fans out
        to all three — server calls jump by exactly 1, every value cross-fades.
      </p>
      <div
        style={{
          display: "flex",
          gap: "1rem",
          flexWrap: "wrap",
          margin: "0.75rem 0 2rem",
        }}
      >
        <VtSharedKeyCard id="rev-a" withButton />
        <VtSharedKeyCard id="rev-b" />
        <VtSharedKeyCard id="rev-c" withButton />
      </div>

      <h2 style={{ fontSize: "1.1rem", color: "#6b7280" }}>Streaming loader</h2>
      <p style={{ color: "#6b7280", margin: "0.25rem 0 0", maxWidth: 640 }}>
        A keyed loader (<code>key="product"</code>) whose header renders
        immediately while a nested <code>details</code> promise streams into a
        nested <code>&lt;Suspense&gt;</code> a beat later. A <code>load()</code>{" "}
        from one card re-streams both from a single fetch, holding the
        already-streamed detail row in place (no nested-skeleton flash).
      </p>
      <div
        style={{
          display: "flex",
          gap: "1rem",
          flexWrap: "wrap",
          margin: "0.75rem 0 2rem",
        }}
      >
        <VtProductCard id="prod-a" withButton />
        <VtProductCard id="prod-b" />
      </div>

      <h2 style={{ fontSize: "1.1rem", color: "#6b7280" }}>
        Refresh group &quot;metrics&quot;
      </h2>
      <div style={{ margin: "0.75rem 0" }}>
        <VtGroupRefreshButton />
      </div>
      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
        <VtGroupCard
          id="users"
          label="Active users"
          loader={ActiveUsersLoader}
        />
        <VtGroupCard
          id="orders"
          label="Open orders"
          loader={OpenOrdersLoader}
        />
        <VtGroupCard id="latency" label="p95 latency" loader={LatencyLoader} />
      </div>
    </main>
  );
}

// Static handler -- centered card layout with shared ViewTransition elements
// that morph into the prerender page's left-aligned layout on navigation.
const StaticPage = Static(() => {
  return (
    <main
      data-testid="static-page"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "60vh",
        gap: "2rem",
      }}
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.5rem",
          padding: "0.375rem 0.75rem",
          borderRadius: "9999px",
          background: "#f0fdf4",
          border: "1px solid #bbf7d0",
          color: "#166534",
          fontSize: "0.75rem",
          fontWeight: 600,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
        }}
      >
        Statically Rendered
      </div>

      <div
        style={{
          background: "white",
          borderRadius: "16px",
          border: "1px solid #e5e7eb",
          padding: "2.5rem",
          maxWidth: "480px",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "1.5rem",
          boxShadow: "0 4px 24px rgba(0,0,0,0.06)",
        }}
      >
        <ViewTransition name="showcase-shape">
          <div
            style={{
              width: "120px",
              height: "120px",
              borderRadius: "24px",
              background:
                "linear-gradient(135deg, #a78bfa 0%, #7c3aed 50%, #4c1d95 100%)",
              boxShadow: "0 8px 32px rgba(124,58,237,0.3)",
            }}
          />
        </ViewTransition>

        <ViewTransition name="showcase-title">
          <h1
            data-testid="static-title"
            style={{
              fontSize: "1.75rem",
              fontWeight: 700,
              letterSpacing: "-0.02em",
              textAlign: "center",
            }}
          >
            Static Page
          </h1>
        </ViewTransition>

        <p
          data-testid="static-content"
          style={{ color: "#6b7280", textAlign: "center", lineHeight: 1.6 }}
        >
          This page is statically rendered at build time.
        </p>

        <ViewTransition name="showcase-timestamp">
          <p
            data-testid="static-timestamp"
            style={{
              color: "#9ca3af",
              fontSize: "0.8rem",
              fontFamily: "monospace",
            }}
          >
            Built at: {Date.now()}
          </p>
        </ViewTransition>

        <a
          href="/prerender"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.5rem",
            padding: "0.625rem 1.25rem",
            borderRadius: "8px",
            background: "#f3f4f6",
            color: "#374151",
            textDecoration: "none",
            fontSize: "0.875rem",
            fontWeight: 500,
          }}
        >
          Go to Prerender &rarr;
        </a>
      </div>
    </main>
  );
});

// Prerender handler -- article index grid with shared ViewTransition elements.
// The header morphs from the Static page's centered card layout.
// Each article card has shared elements that expand into the detail view.
const PrerenderedPage = Prerender(async () => {
  return (
    <main data-testid="prerender-page" style={{ minHeight: "60vh" }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
          marginBottom: "2rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <ViewTransition name="showcase-shape">
            <div
              style={{
                width: "48px",
                height: "48px",
                borderRadius: "12px",
                background:
                  "linear-gradient(135deg, #a78bfa 0%, #7c3aed 50%, #4c1d95 100%)",
                flexShrink: 0,
              }}
            />
          </ViewTransition>
          <div>
            <ViewTransition name="showcase-title">
              <h1
                data-testid="prerender-title"
                style={{
                  fontSize: "2rem",
                  fontWeight: 700,
                  letterSpacing: "-0.02em",
                }}
              >
                Pre-rendered Page
              </h1>
            </ViewTransition>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <p data-testid="prerender-content" style={{ color: "#6b7280" }}>
            This page is pre-rendered.
          </p>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.25rem 0.625rem",
              borderRadius: "9999px",
              background: "#eff6ff",
              border: "1px solid #bfdbfe",
              color: "#1e40af",
              fontSize: "0.7rem",
              fontWeight: 600,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
            }}
          >
            Pre-rendered at build time
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <ViewTransition name="showcase-timestamp">
            <p
              data-testid="prerender-timestamp"
              style={{
                color: "#9ca3af",
                fontSize: "0.8rem",
                fontFamily: "monospace",
              }}
            >
              Built at: {Date.now()}
            </p>
          </ViewTransition>
          <a
            href="/static"
            style={{
              color: "#6b7280",
              textDecoration: "none",
              fontSize: "0.875rem",
            }}
          >
            &larr; Back to Static
          </a>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gap: "1.25rem",
          gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
        }}
      >
        {ARTICLES.map((article) => (
          <a
            key={article.slug}
            href={`/prerender/${article.slug}`}
            data-testid={`prerender-card-${article.slug}`}
            style={{
              textDecoration: "none",
              color: "inherit",
              borderRadius: "12px",
              overflow: "hidden",
              border: "1px solid #e5e7eb",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <ViewTransition name={`article-thumb-${article.slug}`}>
              <div
                style={{
                  height: "120px",
                  background: article.gradient,
                  borderRadius: "12px 12px 0 0",
                }}
              />
            </ViewTransition>
            <div
              style={{
                padding: "1rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
              }}
            >
              <p style={{ color: "#9ca3af", fontSize: "0.75rem" }}>
                {article.date}
              </p>
              <ViewTransition name={`article-title-${article.slug}`}>
                <h3
                  style={{ fontSize: "1rem", fontWeight: 600, lineHeight: 1.3 }}
                >
                  {article.title}
                </h3>
              </ViewTransition>
              <p
                style={{
                  color: "#6b7280",
                  fontSize: "0.8rem",
                  lineHeight: 1.5,
                }}
              >
                {article.excerpt}
              </p>
            </div>
          </a>
        ))}
      </div>
    </main>
  );
});

// Prerender handler -- article detail with hero gradient and shared ViewTransition
// elements that morph from the card thumbnail and title in the article index.
const PrerenderedArticle = Prerender(
  async () => [
    { slug: "edge-rendering" },
    { slug: "incremental-adoption" },
    { slug: "streaming-rsc" },
    { slug: "type-safe-routes" },
    { slug: "hello" },
    { slug: "world" },
  ],
  async (ctx) => {
    const article = ARTICLES.find((a) => a.slug === ctx.params.slug);

    if (!article) {
      return (
        <main data-testid="prerender-article">
          <h1 data-testid="prerender-article-title">{ctx.params.slug}</h1>
          <p data-testid="prerender-article-content">
            Content for {ctx.params.slug}
          </p>
          <p data-testid="prerender-article-timestamp">
            Built at: {Date.now()}
          </p>
        </main>
      );
    }

    return (
      <main data-testid="prerender-article">
        <a
          href="/prerender"
          data-testid="prerender-back"
          style={{
            color: "#6b7280",
            textDecoration: "none",
            display: "inline-block",
            marginBottom: "1.5rem",
            fontSize: "0.875rem",
          }}
        >
          &larr; Back to articles
        </a>

        <ViewTransition name={`article-thumb-${ctx.params.slug}`}>
          <div
            style={{
              height: "240px",
              borderRadius: "16px",
              background: article.gradient,
              marginBottom: "1.5rem",
              boxShadow: `0 8px 32px ${article.color}40`,
            }}
          />
        </ViewTransition>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            marginBottom: "0.5rem",
          }}
        >
          <p style={{ color: "#9ca3af", fontSize: "0.8rem" }}>{article.date}</p>
          <div
            style={{
              padding: "0.2rem 0.5rem",
              borderRadius: "9999px",
              background: "#eff6ff",
              border: "1px solid #bfdbfe",
              color: "#1e40af",
              fontSize: "0.65rem",
              fontWeight: 600,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
            }}
          >
            Pre-rendered
          </div>
        </div>

        <ViewTransition name={`article-title-${ctx.params.slug}`}>
          <h1
            data-testid="prerender-article-title"
            style={{
              fontSize: "2.25rem",
              fontWeight: 700,
              letterSpacing: "-0.02em",
              marginBottom: "1.5rem",
            }}
          >
            {article.title}
          </h1>
        </ViewTransition>

        <div
          data-testid="prerender-article-content"
          style={{
            lineHeight: 1.75,
            color: "#374151",
            marginBottom: "1rem",
          }}
        >
          {article.content}
        </div>

        <p
          data-testid="prerender-article-timestamp"
          style={{
            color: "#9ca3af",
            fontSize: "0.75rem",
            fontFamily: "monospace",
            marginTop: "2rem",
            paddingTop: "1rem",
            borderTop: "1px solid #f3f4f6",
          }}
        >
          Built at: {Date.now()}
        </p>
      </main>
    );
  },
);

// Transition pages — direction-aware sliding
// Visually distinct backgrounds to make slide direction obvious
function TransitionPageA(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "Transition A - React Experimental" });

  return (
    <main
      data-testid="transition-a-page"
      style={{
        background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
        borderRadius: "16px",
        padding: "2rem",
        color: "white",
        minHeight: "300px",
      }}
    >
      <h1
        data-testid="transition-a-title"
        style={{ fontSize: "2rem", marginBottom: "1rem" }}
      >
        Transition Page A
      </h1>
      <p style={{ fontSize: "1.1rem", opacity: 0.9 }}>
        Click "Slide B" to see the slide-right transition.
      </p>
      <p style={{ fontSize: "1.1rem", opacity: 0.9, marginTop: "0.5rem" }}>
        Then press Back to see slide-left (direction-aware).
      </p>
      <div
        style={{
          marginTop: "2rem",
          padding: "1rem",
          background: "rgba(255,255,255,0.15)",
          borderRadius: "8px",
          fontFamily: "monospace",
          fontSize: "0.85rem",
        }}
      >
        enter: {"{"} navigation: "slide-from-right", navigation-back:
        "slide-from-left" {"}"}
      </div>
    </main>
  );
}

function TransitionPageB(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "Transition B - React Experimental" });

  return (
    <main
      data-testid="transition-b-page"
      style={{
        background: "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)",
        borderRadius: "16px",
        padding: "2rem",
        color: "white",
        minHeight: "300px",
      }}
    >
      <h1
        data-testid="transition-b-title"
        style={{ fontSize: "2rem", marginBottom: "1rem" }}
      >
        Transition Page B
      </h1>
      <p style={{ fontSize: "1.1rem", opacity: 0.9 }}>
        Click "Slide A" to slide back, or press browser Back.
      </p>
      <p style={{ fontSize: "1.1rem", opacity: 0.9, marginTop: "0.5rem" }}>
        Back navigation uses "navigation-back" transition type.
      </p>
      <div
        style={{
          marginTop: "2rem",
          padding: "1rem",
          background: "rgba(255,255,255,0.15)",
          borderRadius: "8px",
          fontFamily: "monospace",
          fontSize: "0.85rem",
        }}
      >
        exit: {"{"} navigation: "slide-to-left", navigation-back:
        "slide-to-right" {"}"}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Layout-level transition — pins back-nav firing when transition() is attached
// at the layout segment.
// ---------------------------------------------------------------------------

function LayoutTxShell() {
  return (
    <div data-testid="layout-tx-shell">
      <Outlet />
    </div>
  );
}

// Tall filler so scroll-to-top tests can move scrollY > 0 before navigating.
function ScrollFiller() {
  return (
    <div
      data-testid="scroll-filler"
      style={{ height: "3000px", background: "linear-gradient(#eee, #ccc)" }}
    />
  );
}

function LayoutTxAPage(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "Layout TX A" });
  return (
    <main data-testid="layout-tx-a-page">
      <h1 data-testid="layout-tx-a-title">Layout TX Page A</h1>
      {/* Mid-page link so a scroll-down position keeps the link in view —
          Playwright's .click() would otherwise scroll it into view, resetting
          scrollY before the click fires. */}
      <div style={{ height: "600px" }} />
      <Link to={href("/layout-tx-b")} data-testid="nav-layout-tx-b">
        Go to B
      </Link>
      <ScrollFiller />
    </main>
  );
}

function LayoutTxBPage(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "Layout TX B" });
  return (
    <main data-testid="layout-tx-b-page">
      <h1 data-testid="layout-tx-b-title">Layout TX Page B</h1>
      <Link to={href("/layout-tx-a")} data-testid="nav-layout-tx-a">
        Go to A
      </Link>
    </main>
  );
}

// ---------------------------------------------------------------------------
// View-transition boundary opt-out fixtures
//
// All three route pairs use transition() so navigation is driven through
// startTransition. The transition({ viewTransition }) flag only toggles
// whether the ROUTER places its own <ViewTransition> boundary. The e2e
// (view-transition-optout.test.ts) spies on document.startViewTransition to
// assert the boundary is or isn't placed:
//   - vt-auto-*: transition({})            -> router boundary -> VT fires.
//   - vt-off-*:  transition({ vt: false }) -> no boundary, no user VT -> no VT.
//   - vt-user-*: transition({ vt: false }) + a consumer-placed <ViewTransition>
//                -> no router boundary, but the consumer's named morph fires.
// ---------------------------------------------------------------------------

function VtAutoXPage() {
  return (
    <main data-testid="vt-auto-x-page">
      <h1>VT Auto X</h1>
      <Link to="/vt-auto-y" data-testid="nav-vt-auto-y">
        Go to Y
      </Link>
    </main>
  );
}

function VtAutoYPage() {
  return (
    <main data-testid="vt-auto-y-page">
      <h1>VT Auto Y</h1>
      <Link to="/vt-auto-x" data-testid="nav-vt-auto-x">
        Go to X
      </Link>
    </main>
  );
}

function VtOffXPage() {
  return (
    <main data-testid="vt-off-x-page">
      <h1>VT Off X</h1>
      <Link to="/vt-off-y" data-testid="nav-vt-off-y">
        Go to Y
      </Link>
    </main>
  );
}

function VtOffYPage() {
  return (
    <main data-testid="vt-off-y-page">
      <h1>VT Off Y</h1>
      <Link to="/vt-off-x" data-testid="nav-vt-off-x">
        Go to X
      </Link>
    </main>
  );
}

function VtUserXPage() {
  return (
    <main data-testid="vt-user-x-page">
      <h1>VT User X</h1>
      <ViewTransition name="vt-user-shared">
        <div
          data-testid="vt-user-box"
          style={{ width: "80px", height: "80px", background: "#3b82f6" }}
        />
      </ViewTransition>
      <Link to="/vt-user-y" data-testid="nav-vt-user-y">
        Go to Y
      </Link>
    </main>
  );
}

function VtUserYPage() {
  return (
    <main data-testid="vt-user-y-page">
      <h1>VT User Y</h1>
      <ViewTransition name="vt-user-shared">
        <div
          data-testid="vt-user-box"
          style={{ width: "80px", height: "80px", background: "#ef4444" }}
        />
      </ViewTransition>
      <Link to="/vt-user-x" data-testid="nav-vt-user-x">
        Go to X
      </Link>
    </main>
  );
}

// Per-route transition({ viewTransition: "auto" }) — explicitly forces the
// router boundary. Under a global viewTransition:false default, these must
// still fire (the per-segment value overrides the global default).
function VtForceAutoXPage() {
  return (
    <main data-testid="vt-force-auto-x-page">
      <h1>VT Force Auto X</h1>
      <Link to="/vt-force-auto-y" data-testid="nav-vt-force-auto-y">
        Go to Y
      </Link>
    </main>
  );
}

function VtForceAutoYPage() {
  return (
    <main data-testid="vt-force-auto-y-page">
      <h1>VT Force Auto Y</h1>
      <Link to="/vt-force-auto-x" data-testid="nav-vt-force-auto-x">
        Go to X
      </Link>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Blog example — "Floating Elements"
// Shared element transitions: title, date, avatars morph between list/detail
// ---------------------------------------------------------------------------

interface Author {
  name: string;
  handle: string;
}
interface Post {
  slug: string;
  title: string;
  date: string;
  description: string;
  content: string;
  authors: Author[];
}

const AUTHORS: Record<string, Author> = {
  seb: { name: "Sebastian Markbage", handle: "seb" },
  jiachi: { name: "Jiachi Liu", handle: "jiachi" },
  zack: { name: "Zack Tanner", handle: "zack" },
  lee: { name: "Lee Robinson", handle: "lee" },
};

const POSTS: Post[] = [
  {
    slug: "rsc-routing",
    title: "RSC Routing",
    date: "Feb 26, 2025",
    description:
      "Server-first routing with React Server Components and view transitions.",
    content:
      "RSC routing enables server-first rendering where route handlers run on the server and produce a Flight payload. The client receives this payload and renders the UI without a full page reload. Combined with view transitions, navigation feels instant and animated.",
    authors: [AUTHORS.seb, AUTHORS.jiachi, AUTHORS.zack],
  },
  {
    slug: "composable-caching",
    title: "Composable Caching",
    date: "Jan 3, 2025",
    description:
      "Segment-level caching with cache() boundaries for fine-grained control.",
    content:
      "Composable caching lets you wrap route segments with cache() boundaries. Each cached segment stores its Flight payload independently. When a user navigates, only stale segments are re-rendered on the server — cached ones are served instantly from storage.",
    authors: [AUTHORS.lee],
  },
  {
    slug: "view-transitions",
    title: "View Transitions",
    date: "Dec 10, 2024",
    description:
      "Declarative view transitions using React's experimental ViewTransition API.",
    content:
      "The transition() DSL maps directly to React's <ViewTransition> component. By wrapping individual elements with matching names across pages, you get smooth shared element morphing — a title in a card list flies into the detail page header.",
    authors: [AUTHORS.jiachi, AUTHORS.seb],
  },
];

// Avatar as a colored circle with initials (no image assets needed)
function Avatar({ author, size = 36 }: { author: Author; size?: number }) {
  const colors = ["#e94560", "#0ea5e9", "#22c55e", "#f59e0b", "#8b5cf6"];
  const idx = author.handle.charCodeAt(0) % colors.length;
  const initials = author.name
    .split(" ")
    .map((n) => n[0])
    .join("");
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: colors[idx],
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: "white",
        fontSize: size * 0.38,
        fontWeight: 600,
        border: "2px solid white",
        flexShrink: 0,
      }}
    >
      {initials}
    </div>
  );
}

function BlogIndex(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "Blog - React Experimental" });

  return (
    <main data-testid="blog-index-page">
      <h1
        data-testid="blog-index-title"
        style={{ fontSize: "2rem", marginBottom: "1.5rem" }}
      >
        The Latest News
      </h1>
      <div
        style={{
          display: "grid",
          gap: "1.5rem",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        }}
      >
        {POSTS.map((post) => (
          <div
            key={post.slug}
            data-testid={`blog-card-${post.slug}`}
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: "12px",
              padding: "1.5rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
              }}
            >
              <ViewTransition name={`date-${post.slug}`}>
                <p style={{ color: "#6b7280", fontSize: "0.875rem" }}>
                  {post.date}
                </p>
              </ViewTransition>
              <div style={{ display: "flex", marginLeft: "auto" }}>
                {post.authors.map((author) => (
                  <ViewTransition
                    key={author.handle}
                    name={`avatar-${post.slug}-${author.handle}`}
                  >
                    <div style={{ marginLeft: "-8px" }}>
                      <Avatar author={author} size={32} />
                    </div>
                  </ViewTransition>
                ))}
              </div>
            </div>

            <ViewTransition name={`title-${post.slug}`}>
              <Link
                to={href(`/blog/${post.slug}`)}
                style={{
                  textDecoration: "none",
                  color: "inherit",
                  display: "inline-block",
                }}
              >
                <h2 style={{ fontSize: "1.25rem", fontWeight: 600 }}>
                  {post.title}
                </h2>
              </Link>
            </ViewTransition>

            <ViewTransition name={`authors-${post.slug}`}>
              {null}
            </ViewTransition>

            <p
              style={{ color: "#6b7280", fontSize: "0.9rem", lineHeight: 1.5 }}
            >
              {post.description}
            </p>

            <Link
              to={href(`/blog/${post.slug}`)}
              style={{
                display: "block",
                textAlign: "center",
                padding: "0.5rem 1rem",
                background: "#f3f4f6",
                borderRadius: "6px",
                textDecoration: "none",
                color: "#374151",
                fontSize: "0.875rem",
                marginTop: "auto",
              }}
            >
              Read More
            </Link>
          </div>
        ))}
      </div>
    </main>
  );
}

function BlogDetail(ctx: HandlerContext<{ slug: string }>) {
  const { slug } = ctx.params;
  const post = POSTS.find((p) => p.slug === slug) ?? POSTS[0];
  const meta = ctx.use(Meta);
  meta({ title: `${post.title} - Blog` });

  return (
    <main data-testid="blog-detail-page">
      <Link
        to={href("/blog")}
        data-testid="blog-back"
        style={{
          color: "#3b82f6",
          textDecoration: "none",
          display: "inline-block",
          marginBottom: "1.5rem",
        }}
      >
        &larr; Back to blog
      </Link>

      <ViewTransition name={`date-${slug}`}>
        <time
          style={{ color: "#6b7280", display: "block", marginBottom: "0.5rem" }}
        >
          {post.date}
        </time>
      </ViewTransition>

      <div>
        <ViewTransition name={`title-${slug}`}>
          <h1
            data-testid="blog-detail-title"
            style={{
              fontSize: "2.5rem",
              fontWeight: 700,
              letterSpacing: "-0.02em",
              marginBottom: "2rem",
              display: "inline-block",
            }}
          >
            {post.title}
          </h1>
        </ViewTransition>
      </div>

      <h2
        style={{
          color: "#6b7280",
          fontSize: "0.875rem",
          marginBottom: "0.75rem",
        }}
      >
        Posted by
      </h2>
      <ViewTransition name={`authors-${slug}`}>
        <div
          style={{
            display: "flex",
            gap: "1rem",
            flexWrap: "wrap",
            marginBottom: "2rem",
          }}
        >
          {post.authors.map((author) => (
            <div
              key={author.handle}
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
            >
              <ViewTransition name={`avatar-${slug}-${author.handle}`}>
                <Avatar author={author} size={32} />
              </ViewTransition>
              <div style={{ fontSize: "0.875rem" }}>
                <div>{author.name}</div>
                <div style={{ color: "#6b7280" }}>@{author.handle}</div>
              </div>
            </div>
          ))}
        </div>
      </ViewTransition>

      <div
        data-testid="blog-detail-content"
        style={{ lineHeight: 1.75, color: "#374151" }}
      >
        {post.content}
      </div>

      <Comments slug={slug} />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Cards example — "Transform Cards"
// Split layout with sidebar; card images morph into detail view
// ---------------------------------------------------------------------------

interface Place {
  slug: string;
  name: string;
  description: string;
  gradient: string;
  color: string;
}

const PLACES: Place[] = [
  {
    slug: "florence",
    name: "Florence",
    color: "#e94560",
    gradient: "linear-gradient(135deg, #e94560 0%, #c62a46 50%, #8b1a30 100%)",
    description:
      "A city in central Italy and the capital of the Tuscany region, known for its Renaissance art and architecture.",
  },
  {
    slug: "xian",
    name: "Xi'an",
    color: "#22c55e",
    gradient: "linear-gradient(135deg, #22c55e 0%, #16a34a 50%, #0d6e31 100%)",
    description:
      "An ancient city in China with 2000 years of history, home to the Terracotta Army.",
  },
  {
    slug: "barcelona",
    name: "Barcelona",
    color: "#0ea5e9",
    gradient: "linear-gradient(135deg, #0ea5e9 0%, #0284c7 50%, #075985 100%)",
    description:
      "A city on the coast of northeastern Spain, capital of Catalonia, famous for Gaudi's architecture.",
  },
  {
    slug: "santamonica",
    name: "Santa Monica",
    color: "#f59e0b",
    gradient: "linear-gradient(135deg, #f59e0b 0%, #d97706 50%, #92400e 100%)",
    description:
      "A beachfront city in western Los Angeles County with iconic pier and vibrant boardwalk.",
  },
];

function CardIndex(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "Cards - React Experimental" });

  return (
    <main
      data-testid="card-index-page"
      style={{
        display: "flex",
        gap: "2rem",
        margin: "-2rem",
        minHeight: "100vh",
      }}
    >
      {/* Left sidebar */}
      <ViewTransition name="card-sidebar">
        <div
          style={{
            width: "50%",
            background: "linear-gradient(135deg, #6ee7b7 0%, #34d399 100%)",
            padding: "2rem",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            position: "relative",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              width: "300px",
              height: "300px",
              borderRadius: "50%",
              background: "rgba(59,130,246,0.3)",
              filter: "blur(60px)",
              top: "20%",
              left: "25%",
            }}
          />
          <div style={{ position: "relative", zIndex: 1 }}>
            <p
              style={{
                color: "#374151",
                fontWeight: 700,
                marginBottom: "1rem",
              }}
            >
              {"<ViewTransition>"}
            </p>
            <Link
              to={href("/")}
              style={{
                color: "#374151",
                textDecoration: "none",
                display: "block",
                marginBottom: "2rem",
              }}
            >
              &larr; Back
            </Link>
            <h1
              style={{
                fontSize: "3rem",
                fontFamily: "Georgia, serif",
                color: "#1f2937",
              }}
            >
              Explore
              <br />
              <span style={{ fontSize: "2rem" }}>The cities.</span>
            </h1>
          </div>
        </div>
      </ViewTransition>

      {/* Right content — card grid */}
      <ViewTransition name="card-content">
        <div style={{ width: "50%", padding: "2rem" }}>
          <h2
            style={{
              color: "#6b7280",
              fontSize: "1.1rem",
              marginBottom: "1rem",
            }}
          >
            Spots
          </h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
            {PLACES.map((place) => (
              <Link
                key={place.slug}
                to={href(`/cards/${place.slug}`)}
                style={{ textDecoration: "none", width: "calc(50% - 0.5rem)" }}
              >
                <div
                  data-testid={`card-${place.slug}`}
                  style={{
                    position: "relative",
                    borderRadius: "12px",
                    overflow: "hidden",
                    height: "200px",
                    cursor: "pointer",
                  }}
                >
                  <ViewTransition name={`place-image-${place.slug}`}>
                    <div
                      style={{
                        width: "100%",
                        height: "100%",
                        background: place.gradient,
                        transition: "transform 0.15s",
                        borderRadius: "12px",
                      }}
                    />
                  </ViewTransition>
                  <ViewTransition name={`place-name-${place.slug}`}>
                    <div
                      style={{
                        position: "absolute",
                        bottom: "12px",
                        right: "12px",
                        color: "white",
                        fontSize: "1.5rem",
                        fontWeight: 600,
                        textShadow: "0 2px 8px rgba(0,0,0,0.4)",
                      }}
                    >
                      {place.name}
                    </div>
                  </ViewTransition>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </ViewTransition>
    </main>
  );
}

function CardDetail(ctx: HandlerContext<{ slug: string }>) {
  const { slug } = ctx.params;
  const place = PLACES.find((p) => p.slug === slug) ?? PLACES[0];
  const meta = ctx.use(Meta);
  meta({ title: `${place.name} - Cards` });

  return (
    <main
      data-testid="card-detail-page"
      style={{
        margin: "-2rem",
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          width: "100%",
          padding: "2rem",
          gap: "2rem",
          alignItems: "center",
        }}
      >
        {/* Main image area */}
        <div style={{ position: "relative", flex: 1 }}>
          <ViewTransition name="back-button">
            <Link
              to={href("/cards")}
              data-testid="card-back"
              style={{
                position: "absolute",
                top: "16px",
                left: "16px",
                zIndex: 2,
                color: "white",
                textDecoration: "none",
                filter: "drop-shadow(2px 2px 6px rgba(0,0,0,0.5))",
                fontSize: "1.5rem",
              }}
            >
              &larr;
            </Link>
          </ViewTransition>

          <ViewTransition name={`place-image-${slug}`}>
            <div
              style={{
                width: "100%",
                height: "70vh",
                background: place.gradient,
                borderRadius: "12px",
                position: "relative",
              }}
            />
          </ViewTransition>

          <ViewTransition name={`place-name-${slug}`}>
            <div
              style={{
                position: "absolute",
                bottom: "16px",
                right: "16px",
                color: "white",
                fontSize: "2rem",
                fontWeight: 600,
                textShadow: "0 2px 12px rgba(0,0,0,0.4)",
              }}
            >
              {place.name}
            </div>
          </ViewTransition>
        </div>

        {/* Sidebar with all places */}
        <ViewTransition name="card-content">
          <div style={{ width: "220px", flexShrink: 0 }}>
            <h3
              data-testid="card-detail-title"
              style={{
                fontSize: "1.1rem",
                color: "#374151",
                marginBottom: "1rem",
              }}
            >
              Spots
            </h3>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.75rem",
              }}
            >
              {PLACES.map((p) => (
                <Link
                  key={p.slug}
                  to={href(`/cards/${p.slug}`)}
                  style={{
                    textDecoration: "none",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.75rem",
                  }}
                >
                  <ViewTransition name={`place-image-${p.slug}`}>
                    <div
                      style={{
                        width: "60px",
                        height: "60px",
                        borderRadius: "8px",
                        background: p.gradient,
                        flexShrink: 0,
                      }}
                    />
                  </ViewTransition>
                  <span style={{ color: "#374151", fontSize: "0.875rem" }}>
                    {p.name}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </ViewTransition>
      </div>
    </main>
  );
}

export const urlpatterns = urls(
  ({ path, layout, transition, loader, loading }) => [
    // Root layout: pushes the GTM bootstrap into the Script handle on EVERY route
    // (app-wide), rendered by <Scripts/> in the Document <head>. Owning the push
    // here (rather than per-page) means /about, /counter, etc. also get the
    // bootstrap + first page_view; soft-nav page_views come from <GtmPageViews>.
    layout(
      (ctx) => {
        ctx.use(Script)({
          id: "gtm",
          children: generateGtmInit(DEFAULT_GTM_ID),
        });
        return <Outlet />;
      },
      () => [
        path("/", HomePage, { name: "home" }),
        path("/about", AboutPage, { name: "about" }),
        path("/counter", CounterPage, { name: "counter" }),
        path("/refresh", RefreshDemoPage, { name: "refresh" }, () => [
          loader(RevenueLoader),
          loader(ProductLoader),
        ]),

        // Layout-level transition (no-children form, sibling of path()).
        // Pins that back-nav fires the navigation-back transition type when the
        // transition is attached at the LAYOUT segment, not the path segments.
        layout(LayoutTxShell, () => [
          transition({
            enter: {
              navigation: "slide-from-right",
              "navigation-back": "slide-from-left",
            },
            exit: {
              navigation: "slide-to-left",
              "navigation-back": "slide-to-right",
            },
          }),
          path("/layout-tx-a", LayoutTxAPage, { name: "layoutTx.a" }),
          path("/layout-tx-b", LayoutTxBPage, { name: "layoutTx.b" }),
        ]),

        // View-transition boundary opt-out: transition({ viewTransition }) toggles
        // only the router-placed boundary. All three pairs drive navigation; the
        // e2e asserts (via a startViewTransition spy) which placements fire.
        path("/vt-auto-x", VtAutoXPage, { name: "vt.auto.x" }, () => [
          transition({}),
        ]),
        path("/vt-auto-y", VtAutoYPage, { name: "vt.auto.y" }, () => [
          transition({}),
        ]),
        path("/vt-off-x", VtOffXPage, { name: "vt.off.x" }, () => [
          transition({ viewTransition: false }),
        ]),
        path("/vt-off-y", VtOffYPage, { name: "vt.off.y" }, () => [
          transition({ viewTransition: false }),
        ]),
        path("/vt-user-x", VtUserXPage, { name: "vt.user.x" }, () => [
          transition({ viewTransition: false }),
        ]),
        path("/vt-user-y", VtUserYPage, { name: "vt.user.y" }, () => [
          transition({ viewTransition: false }),
        ]),
        // Explicit per-route boundary — overrides a global viewTransition:false.
        path(
          "/vt-force-auto-x",
          VtForceAutoXPage,
          { name: "vt.forceAuto.x" },
          () => [transition({ viewTransition: "auto" })],
        ),
        path(
          "/vt-force-auto-y",
          VtForceAutoYPage,
          { name: "vt.forceAuto.y" },
          () => [transition({ viewTransition: "auto" })],
        ),
        transition({ enter: "fade-in", exit: "fade-out" }, () => [
          path("/static", StaticPage, { name: "static" }),
          path("/prerender", PrerenderedPage, { name: "prerender" }),
          path("/prerender/:slug", PrerenderedArticle, {
            name: "prerender.article",
          }),
        ]),

        // Direction-aware transitions (ViewTransitionClass object form)
        path("/transition-a", TransitionPageA, { name: "transition.a" }, () => [
          transition({
            enter: {
              navigation: "slide-from-right",
              "navigation-back": "slide-from-left",
            },
            exit: {
              navigation: "slide-to-left",
              "navigation-back": "slide-to-right",
            },
          }),
        ]),
        path("/transition-b", TransitionPageB, { name: "transition.b" }, () => [
          transition({
            enter: {
              navigation: "slide-from-right",
              "navigation-back": "slide-from-left",
            },
            exit: {
              navigation: "slide-to-left",
              "navigation-back": "slide-to-right",
            },
          }),
        ]),

        // Blog — wrapper-position transition() enables startTransition for all
        // child routes at once. Element-level <ViewTransition> wrappers in JSX handle the
        // shared morphing (title, date, avatars fly between index and detail).
        transition(() => [
          path("/blog", BlogIndex, { name: "blog" }),
          path("/blog/:slug", BlogDetail, { name: "blog.detail" }, () => [
            loader(CommentsLoader),
          ]),
        ]),

        // Cards — per-route transition() (same effect, different DSL position).
        path("/cards", CardIndex, { name: "cards" }, () => [transition()]),
        path("/cards/:slug", CardDetail, { name: "cards.detail" }, () => [
          transition(),
        ]),

        // Same-route stale-while-revalidate + morph: a :param route with a loading()
        // skeleton AND transition(). On experimental React the persistent
        // <ViewTransition> boundary animates the same-route param swap (morph) while
        // the previous content is held — no skeleton flash. Mirrors the stable
        // test-app swr-product route so the no-skeleton contract is proven on both.
        path(
          "/swr-product/:id",
          async (ctx) => {
            const { name, loadedAt } = await ctx.use(SwrProductLoader);
            return (
              <div data-testid="swr-product-page">
                <h1 data-testid="swr-product-name">{name}</h1>
                <p data-testid="swr-product-loaded-at">{loadedAt}</p>
                <SwrProductCounter />
                <nav>
                  <Link to="/swr-product/1" data-testid="swr-product-link-1">
                    1
                  </Link>
                  <Link to="/swr-product/2" data-testid="swr-product-link-2">
                    2
                  </Link>
                  <Link to="/swr-product/3" data-testid="swr-product-link-3">
                    3
                  </Link>
                </nav>
              </div>
            );
          },
          { name: "swrProduct.detail" },
          () => [
            loader(SwrProductLoader),
            loading(<div data-testid="swr-product-skeleton">Loading…</div>),
            transition({}),
          ],
        ),

        // Contrast: same :param + loading() but NO transition() -> remounts on param
        // change and shows the skeleton (default behavior, unchanged).
        path(
          "/plain-product/:id",
          async (ctx) => {
            const { name } = await ctx.use(SwrProductLoader);
            return (
              <div data-testid="plain-product-page">
                <h1 data-testid="plain-product-name">{name}</h1>
                <SwrProductCounter />
                <nav>
                  <Link
                    to="/plain-product/1"
                    data-testid="plain-product-link-1"
                  >
                    1
                  </Link>
                  <Link
                    to="/plain-product/2"
                    data-testid="plain-product-link-2"
                  >
                    2
                  </Link>
                </nav>
              </div>
            );
          },
          { name: "plainProduct.detail" },
          () => [
            loader(SwrProductLoader),
            loading(<div data-testid="plain-product-skeleton">Loading…</div>),
          ],
        ),
      ],
    ),
  ],
);
