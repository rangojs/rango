export interface Article {
  slug: string;
  title: string;
  date: string;
  excerpt: string;
  content: string;
  gradient: string;
  color: string;
}

export const ARTICLES: Article[] = [
  {
    slug: "edge-rendering",
    title: "Edge Rendering",
    date: "Mar 15, 2025",
    excerpt:
      "Deploy server components at the edge for instant global response times.",
    content:
      "Edge rendering pushes server component execution to CDN edge nodes closest to users. Instead of routing every request to a central origin server, the RSC handler runs in the same datacenter as the user. Combined with pre-rendering, frequently-accessed routes serve instantly from stored Flight payloads while dynamic routes render at the edge with minimal latency.",
    gradient: "linear-gradient(135deg, #6366f1 0%, #4f46e5 50%, #3730a3 100%)",
    color: "#6366f1",
  },
  {
    slug: "incremental-adoption",
    title: "Incremental Adoption",
    date: "Feb 28, 2025",
    excerpt:
      "Migrate page by page from your existing framework without a rewrite.",
    content:
      "Incremental adoption means you can introduce server components into an existing app one route at a time. Each route independently opts into RSC rendering while the rest of your app continues using its current architecture. Pre-rendering works per-route as well — mark individual routes for build-time rendering while others remain fully dynamic.",
    gradient: "linear-gradient(135deg, #ec4899 0%, #db2777 50%, #9d174d 100%)",
    color: "#ec4899",
  },
  {
    slug: "streaming-rsc",
    title: "Streaming RSC",
    date: "Jan 20, 2025",
    excerpt:
      "Stream server component output progressively for faster first paint.",
    content:
      "Streaming RSC sends Flight payload chunks as they become available. The browser starts rendering the top of the page while deeper components are still executing on the server. Suspense boundaries define the streaming granularity — each boundary can independently resolve and flush its content to the client.",
    gradient: "linear-gradient(135deg, #14b8a6 0%, #0d9488 50%, #0f766e 100%)",
    color: "#14b8a6",
  },
  {
    slug: "type-safe-routes",
    title: "Type-Safe Routes",
    date: "Dec 5, 2024",
    excerpt: "Generated route types catch broken links at compile time.",
    content:
      "Type-safe routes generate TypeScript types from your route definitions. The href() helper validates route names and parameters at compile time, catching broken links before they reach production. When you rename a route or change its parameters, the compiler flags every reference that needs updating.",
    gradient: "linear-gradient(135deg, #f59e0b 0%, #d97706 50%, #92400e 100%)",
    color: "#f59e0b",
  },
  {
    slug: "hello",
    title: "Hello World",
    date: "Nov 1, 2024",
    excerpt:
      "A minimal example demonstrating the basics of pre-rendered routes.",
    content: "Content for hello",
    gradient: "linear-gradient(135deg, #8b5cf6 0%, #7c3aed 50%, #5b21b6 100%)",
    color: "#8b5cf6",
  },
  {
    slug: "world",
    title: "World Tour",
    date: "Oct 15, 2024",
    excerpt: "Exploring pre-rendering across different deployment targets.",
    content: "Content for world",
    gradient: "linear-gradient(135deg, #ef4444 0%, #dc2626 50%, #991b1b 100%)",
    color: "#ef4444",
  },
];
