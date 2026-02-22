import { urls, Static, Prerender } from "@rangojs/router";
import { Meta } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";
import { Counter } from "./components/Counter.js";
import { getCounter } from "./actions/counter.js";

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

export const urlpatterns = urls(({ path }) => [
  path("/", HomePage, { name: "home" }),
  path("/about", AboutPage, { name: "about" }),
  path("/counter", CounterPage, { name: "counter" }),
  path("/static", StaticPage, { name: "static" }),
  path("/prerender", PrerenderedPage, { name: "prerender" }),
  path("/prerender/:slug", PrerenderedArticle, { name: "prerender.article" }),
]);
