export interface MagazineAuthor {
  slug: string;
  name: string;
  bio: string;
}

export interface MagazineArticle {
  slug: string;
  title: string;
  authorSlug: string;
  date: string;
}

export const magazineAuthors: MagazineAuthor[] = [
  {
    slug: "alice-writer",
    name: "Alice Writer",
    bio: "Magazine editor focused on design systems and CSS architecture. Over a decade of experience building scalable UI libraries.",
  },
  {
    slug: "bob-editor",
    name: "Bob Editor",
    bio: "Technical editor specializing in web performance and optimization. Regular speaker at web conferences.",
  },
];

export const magazineArticles: MagazineArticle[] = [
  { slug: "design-systems", title: "Design Systems", authorSlug: "alice-writer", date: "2024-02-01" },
  { slug: "css-architecture", title: "CSS Architecture", authorSlug: "alice-writer", date: "2024-02-10" },
  { slug: "performance-tips", title: "Performance Tips", authorSlug: "bob-editor", date: "2024-02-15" },
];

export function getMagazineAuthor(slug: string): MagazineAuthor | undefined {
  return magazineAuthors.find((a) => a.slug === slug);
}

export function getArticle(slug: string): MagazineArticle | undefined {
  return magazineArticles.find((a) => a.slug === slug);
}

export function getAuthorArticles(authorSlug: string): MagazineArticle[] {
  return magazineArticles.filter((a) => a.authorSlug === authorSlug);
}
