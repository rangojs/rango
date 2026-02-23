import { urls, Static, Prerender } from "@rangojs/router";
import { Meta } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";
import { Link, href } from "@rangojs/router/client";
import { Counter } from "./components/Counter.js";
import { getCounter } from "./actions/counter.js";
import * as React from "react";

// React experimental ViewTransition for element-level shared transitions.
// Wrapping individual elements with the same `name` across pages creates
// a shared element morph (the card title flies into the detail title).
const VT: React.FC<{
  name?: string; share?: string; enter?: string; exit?: string;
  children: React.ReactNode;
}> = "ViewTransition" in React ? (React as any).ViewTransition : React.Fragment;

function HomePage(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "Home - React Experimental" });
  meta({ name: "description", content: "RSC Router example with experimental React" });

  return (
    <main data-testid="home-page">
      <h1 data-testid="home-title">Welcome to RSC Router</h1>
      <p>This example tests compatibility with React's experimental release channel.</p>
    </main>
  );
}

function AboutPage(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "About - React Experimental" });
  meta({ name: "description", content: "About the React experimental example" });

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
  meta({ name: "description", content: "Interactive counter with Server Actions" });

  const initialCount = await getCounter();

  return (
    <main data-testid="counter-page">
      <h1 data-testid="counter-title">Counter Demo</h1>
      <Counter initialCount={initialCount} />
    </main>
  );
}

// Static handler -- rendered once at build time, frozen in production
const StaticPage = Static(() => {
  return (
    <main data-testid="static-page">
      <h1 data-testid="static-title">Static Page</h1>
      <p data-testid="static-content">This page is statically rendered at build time.</p>
      <p data-testid="static-timestamp">Built at: {Date.now()}</p>
    </main>
  );
});

// Prerender handler -- no params, rendered at build time
const PrerenderedPage = Prerender(async (ctx) => {
  return (
    <main data-testid="prerender-page">
      <h1 data-testid="prerender-title">Pre-rendered Page</h1>
      <p data-testid="prerender-content">This page is pre-rendered.</p>
      <p data-testid="prerender-timestamp">Built at: {Date.now()}</p>
    </main>
  );
});

// Prerender handler -- with params, rendered at build time for each param set
const PrerenderedArticle = Prerender(
  async () => [{ slug: "hello" }, { slug: "world" }],
  async (ctx) => {
    return (
      <main data-testid="prerender-article">
        <h1 data-testid="prerender-article-title">{ctx.params.slug}</h1>
        <p data-testid="prerender-article-content">Content for {ctx.params.slug}</p>
        <p data-testid="prerender-article-timestamp">Built at: {Date.now()}</p>
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
    <main data-testid="transition-a-page" style={{
      background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
      borderRadius: "16px", padding: "2rem", color: "white", minHeight: "300px",
    }}>
      <h1 data-testid="transition-a-title" style={{ fontSize: "2rem", marginBottom: "1rem" }}>
        Transition Page A
      </h1>
      <p style={{ fontSize: "1.1rem", opacity: 0.9 }}>
        Click "Slide B" to see the slide-right transition.
      </p>
      <p style={{ fontSize: "1.1rem", opacity: 0.9, marginTop: "0.5rem" }}>
        Then press Back to see slide-left (direction-aware).
      </p>
      <div style={{
        marginTop: "2rem", padding: "1rem", background: "rgba(255,255,255,0.15)",
        borderRadius: "8px", fontFamily: "monospace", fontSize: "0.85rem",
      }}>
        enter: {"{"} navigation: "slide-from-right", navigation-back: "slide-from-left" {"}"}
      </div>
    </main>
  );
}

function TransitionPageB(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "Transition B - React Experimental" });

  return (
    <main data-testid="transition-b-page" style={{
      background: "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)",
      borderRadius: "16px", padding: "2rem", color: "white", minHeight: "300px",
    }}>
      <h1 data-testid="transition-b-title" style={{ fontSize: "2rem", marginBottom: "1rem" }}>
        Transition Page B
      </h1>
      <p style={{ fontSize: "1.1rem", opacity: 0.9 }}>
        Click "Slide A" to slide back, or press browser Back.
      </p>
      <p style={{ fontSize: "1.1rem", opacity: 0.9, marginTop: "0.5rem" }}>
        Back navigation uses "navigation-back" transition type.
      </p>
      <div style={{
        marginTop: "2rem", padding: "1rem", background: "rgba(255,255,255,0.15)",
        borderRadius: "8px", fontFamily: "monospace", fontSize: "0.85rem",
      }}>
        exit: {"{"} navigation: "slide-to-left", navigation-back: "slide-to-right" {"}"}
      </div>
    </main>
  );
}

// Gallery data
const galleryItems = [
  { id: "1", title: "Sunset", color: "#e94560", bg: "#1a1a2e", desc: "Golden hour over the mountains" },
  { id: "2", title: "Ocean", color: "#0ea5e9", bg: "#0c1222", desc: "Deep blue waves crashing" },
  { id: "3", title: "Forest", color: "#22c55e", bg: "#0a1a0e", desc: "Ancient trees and morning mist" },
  { id: "4", title: "Desert", color: "#f59e0b", bg: "#1a150a", desc: "Endless golden sand dunes" },
];

// Gallery index — card grid with links to detail pages
function GalleryIndex(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "Gallery - React Experimental" });

  return (
    <main data-testid="gallery-index-page" style={{ padding: "1rem 0" }}>
      <h1 data-testid="gallery-index-title" style={{ marginBottom: "1.5rem" }}>Gallery</h1>
      <p style={{ marginBottom: "1.5rem", color: "#666" }}>
        Click a card to see named shared transitions. The card morphs into the detail view.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
        {galleryItems.map((item) => (
          <Link key={item.id} to={href(`/gallery/${item.id}`)} style={{ textDecoration: "none" }}>
            <VT name={`card-${item.id}`} share="gallery-morph">
              <div data-testid={`gallery-card-${item.id}`} style={{
                background: item.bg, borderRadius: "12px", padding: "1.5rem",
                border: `2px solid ${item.color}`, color: "white", minHeight: "120px",
                cursor: "pointer", transition: "transform 0.15s",
              }}>
                <h3 style={{ color: item.color, marginBottom: "0.5rem" }}>{item.title}</h3>
                <p style={{ opacity: 0.7, fontSize: "0.9rem" }}>{item.desc}</p>
              </div>
            </VT>
          </Link>
        ))}
      </div>
    </main>
  );
}

// Gallery detail — expanded view of a single item
function GalleryDetail(ctx: HandlerContext) {
  const { id } = ctx.params;
  const item = galleryItems.find((i) => i.id === id) ?? galleryItems[0];
  const meta = ctx.use(Meta);
  meta({ title: `${item.title} - Gallery` });

  return (
    <main data-testid="gallery-detail-page" style={{ padding: "1rem 0" }}>
      <Link to={href("/gallery")} data-testid="gallery-back" style={{
        display: "inline-block", marginBottom: "1rem", color: item.color,
        textDecoration: "none", fontSize: "0.9rem",
      }}>
        &larr; Back to Gallery
      </Link>
      <VT name={`card-${id}`} share="gallery-morph">
        <div style={{
          background: item.bg, borderRadius: "16px", padding: "2rem",
          border: `2px solid ${item.color}`, color: "white", minHeight: "300px",
        }}>
          <h1 data-testid="gallery-detail-title" style={{
            color: item.color, fontSize: "2.5rem", marginBottom: "1rem",
          }}>
            {item.title}
          </h1>
          <p data-testid="gallery-detail-desc" style={{ fontSize: "1.2rem", opacity: 0.9, marginBottom: "1.5rem" }}>
            {item.desc}
          </p>
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem",
          }}>
            <div style={{
              background: `${item.color}22`, borderRadius: "8px", padding: "1rem",
            }}>
              <h4 style={{ color: item.color }}>Shared Element</h4>
              <p style={{ opacity: 0.6, fontSize: "0.85rem", marginTop: "0.25rem" }}>
                {"<VT name={`card-${id}`}>"} — same name in index card and detail
              </p>
            </div>
            <div style={{
              background: `${item.color}22`, borderRadius: "8px", padding: "1rem",
            }}>
              <h4 style={{ color: item.color }}>Morph</h4>
              <p style={{ opacity: 0.6, fontSize: "0.85rem", marginTop: "0.25rem" }}>
                share="gallery-morph" — card expands into detail view
              </p>
            </div>
          </div>
        </div>
      </VT>
    </main>
  );
}

export const urlpatterns = urls(({ path, transition }) => [
  path("/", HomePage, { name: "home" }),
  path("/about", AboutPage, { name: "about" }),
  path("/counter", CounterPage, { name: "counter" }),
  path("/static", StaticPage, { name: "static" }),
  path("/prerender", PrerenderedPage, { name: "prerender" }),
  path("/prerender/:slug", PrerenderedArticle, { name: "prerender.article" }),

  // Direction-aware transitions (ViewTransitionClass object form)
  path("/transition-a", TransitionPageA, { name: "transition.a" }, () => [
    transition({
      enter: { "navigation": "slide-from-right", "navigation-back": "slide-from-left" },
      exit: { "navigation": "slide-to-left", "navigation-back": "slide-to-right" },
    }),
  ]),
  path("/transition-b", TransitionPageB, { name: "transition.b" }, () => [
    transition({
      enter: { "navigation": "slide-from-right", "navigation-back": "slide-from-left" },
      exit: { "navigation": "slide-to-left", "navigation-back": "slide-to-right" },
    }),
  ]),

  // Named shared transitions — index and detail share a ViewTransition name
  // so React morphs between them (shared element transition)
  path("/gallery", GalleryIndex, { name: "gallery" }, () => [
    transition({
      name: "gallery-content",
      enter: "fade-in",
      exit: "fade-out",
    }),
  ]),
  path("/gallery/:id", GalleryDetail, { name: "gallery.detail" }, () => [
    transition({
      name: "gallery-content",
      share: "gallery-morph",
      enter: "slide-up",
      exit: "slide-down",
    }),
  ]),
]);
