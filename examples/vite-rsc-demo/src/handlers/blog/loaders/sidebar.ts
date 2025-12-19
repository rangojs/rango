import { createLoader } from "rsc-router";

export type BlogSidebarData = {
  recentPosts: { slug: string; title: string; date: string }[];
  categories: { name: string; count: number }[];
  tags: string[];
};

const mockSidebarData: BlogSidebarData = {
  recentPosts: [
    { slug: "hello-world", title: "Hello World", date: "2024-01-15" },
    { slug: "rsc-routing", title: "RSC Routing Patterns", date: "2024-01-10" },
    {
      slug: "parallel-routes",
      title: "Understanding Parallel Routes",
      date: "2024-01-05",
    },
  ],
  categories: [
    { name: "React", count: 12 },
    { name: "TypeScript", count: 8 },
    { name: "RSC", count: 5 },
    { name: "Routing", count: 3 },
  ],
  tags: ["react", "rsc", "typescript", "routing", "server-components", "vite"],
};

/**
 * Blog Sidebar Loader - fetches sidebar data
 *
 * Demonstrates parallel routes with their own loaders.
 * Has artificial delay to showcase loading states.
 */
export const BlogSidebarLoader = createLoader("blog-sidebar", async (_ctx) => {
  "use server";
  // Simulate slow API call to demonstrate loading state
  await new Promise((resolve) => setTimeout(resolve, 5500));
  return mockSidebarData;
});
