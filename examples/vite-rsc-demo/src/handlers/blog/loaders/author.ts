import { createLoader } from "@rangojs/router";
import { getAuthor, getPostsByAuthor } from "../data/mock-data.js";
import type { Author, BlogPostMeta } from "../data/mock-data.js";

export type BlogAuthorData = {
  author: Author | undefined;
  posts: BlogPostMeta[];
};

export const BlogAuthorLoader = createLoader(async (ctx) => {
  "use server";
  // Small delay for loading state demo
  await new Promise((r) => setTimeout(r, 800));
  const authorSlug = ctx.params.authorSlug as string;
  const author = getAuthor(authorSlug);
  const posts = getPostsByAuthor(authorSlug);
  return { author, posts } as BlogAuthorData;
});
