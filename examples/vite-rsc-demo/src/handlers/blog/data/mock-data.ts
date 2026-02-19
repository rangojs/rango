export interface Author {
  slug: string;
  name: string;
  bio: string;
}

export interface BlogPostMeta {
  slug: string;
  title: string;
  authorSlug: string;
  date: string;
}

export const authors: Author[] = [
  {
    slug: "jane-doe",
    name: "Jane Doe",
    bio: "Senior React engineer and RSC enthusiast. Writes about server components, routing patterns, and modern web architecture.",
  },
  {
    slug: "john-smith",
    name: "John Smith",
    bio: "Framework architect specializing in Vite plugins and build tooling. Contributor to several open-source routing libraries.",
  },
];

export const blogPostsMeta: BlogPostMeta[] = [
  { slug: "hello-world", title: "Hello World", authorSlug: "jane-doe", date: "2024-01-15" },
  { slug: "react-server-components", title: "React Server Components", authorSlug: "jane-doe", date: "2024-01-10" },
  { slug: "router-design", title: "Router Design", authorSlug: "john-smith", date: "2024-01-05" },
];

export function getAuthor(slug: string): Author | undefined {
  return authors.find((a) => a.slug === slug);
}

export function getPostsByAuthor(authorSlug: string): BlogPostMeta[] {
  return blogPostsMeta.filter((p) => p.authorSlug === authorSlug);
}

export function getPostAuthor(postSlug: string): Author | undefined {
  const post = blogPostsMeta.find((p) => p.slug === postSlug);
  if (!post) return undefined;
  return getAuthor(post.authorSlug);
}

export function slugToTitle(slug: string): string {
  return slug
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}
