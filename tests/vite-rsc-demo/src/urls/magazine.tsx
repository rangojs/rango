import { urls, Prerender, Meta } from "@rangojs/router";
import { Breadcrumbs } from "../handles/breadcrumbs.js";
import { MagazineLayout } from "../layouts/MagazineLayout.js";
import {
  magazineArticles,
  magazineAuthors,
  getArticle,
  getMagazineAuthor,
  getAuthorArticles,
} from "../handlers/magazine/data/mock-data.js";
import { MagazineIndexPage } from "../handlers/magazine/components/MagazineIndexPage.js";
import { MagazineArticlePage } from "../handlers/magazine/components/MagazineArticlePage.js";
import { MagazineAuthorDetail } from "../handlers/magazine/components/MagazineAuthorDetail.js";
import { MagazineAuthorPostsPage } from "../handlers/magazine/components/MagazineAuthorPostsPage.js";

// Static index -- pre-rendered at build time
export const MagazineIndex = Prerender<{}>(async (ctx) => {
  const articlesWithUrls = magazineArticles.map((article) => {
    const author = magazineAuthors.find((a) => a.slug === article.authorSlug);
    return {
      ...article,
      url: ctx.reverse(".article", { slug: article.slug }),
      authorUrl: author
        ? ctx.reverse(".author", { authorSlug: author.slug })
        : undefined,
      authorName: author?.name,
    };
  });
  const authorsWithUrls = magazineAuthors.map((author) => ({
    ...author,
    url: ctx.reverse(".author", { authorSlug: author.slug }),
  }));
  return (
    <MagazineIndexPage articles={articlesWithUrls} authors={authorsWithUrls} />
  );
});

// Dynamic article detail -- pre-rendered for each article slug
export const MagazineArticle = Prerender<{ slug: string }>(
  async () => magazineArticles.map((a) => ({ slug: a.slug })),
  async (ctx) => {
    const push = ctx.use(Breadcrumbs);
    const meta = ctx.use(Meta);
    const article = getArticle(ctx.params.slug)!;
    const author = getMagazineAuthor(article.authorSlug);
    const articleUrl = ctx.reverse(".article", { slug: ctx.params.slug });
    push({ label: article.title, href: articleUrl });
    meta({ title: article.title });
    meta({
      "script:ld+json": {
        "@context": "https://schema.org",
        "@type": "Article",
        headline: article.title,
        author: author ? { "@type": "Person", name: author.name } : undefined,
      },
    });
    return (
      <MagazineArticlePage
        article={article}
        author={author}
        authorUrl={
          author
            ? ctx.reverse(".author", { authorSlug: author.slug })
            : undefined
        }
        indexUrl={ctx.reverse(".index")}
      />
    );
  },
);

// Dynamic author page -- pre-rendered for each author
export const MagazineAuthor = Prerender<{ authorSlug: string }>(
  async () => magazineAuthors.map((a) => ({ authorSlug: a.slug })),
  async (ctx) => {
    const push = ctx.use(Breadcrumbs);
    const meta = ctx.use(Meta);
    const author = getMagazineAuthor(ctx.params.authorSlug)!;
    const articles = getAuthorArticles(ctx.params.authorSlug);
    const authorUrl = ctx.reverse(".author", {
      authorSlug: ctx.params.authorSlug,
    });
    push({ label: author.name, href: authorUrl });
    meta({ title: author.name });
    const articlesWithUrls = articles.map((a) => ({
      ...a,
      url: ctx.reverse(".article", { slug: a.slug }),
    }));
    return (
      <MagazineAuthorDetail
        author={author}
        articles={articlesWithUrls}
        authorPostsUrl={ctx.reverse(".author.posts", {
          authorSlug: ctx.params.authorSlug,
        })}
        indexUrl={ctx.reverse(".index")}
      />
    );
  },
);

// Dynamic author posts -- pre-rendered for each author
export const MagazineAuthorPosts = Prerender<{ authorSlug: string }>(
  async () => magazineAuthors.map((a) => ({ authorSlug: a.slug })),
  async (ctx) => {
    const push = ctx.use(Breadcrumbs);
    const meta = ctx.use(Meta);
    const author = getMagazineAuthor(ctx.params.authorSlug)!;
    const articles = getAuthorArticles(ctx.params.authorSlug);
    const authorUrl = ctx.reverse(".author", {
      authorSlug: ctx.params.authorSlug,
    });
    push({ label: author.name, href: authorUrl });
    meta({ title: `Articles by ${author.name}` });
    push({
      label: "Articles",
      href: ctx.reverse(".author.posts", { authorSlug: ctx.params.authorSlug }),
    });
    const articlesWithUrls = articles.map((a) => ({
      ...a,
      url: ctx.reverse(".article", { slug: a.slug }),
    }));
    return (
      <MagazineAuthorPostsPage
        author={author}
        articles={articlesWithUrls}
        authorUrl={authorUrl}
        indexUrl={ctx.reverse(".index")}
      />
    );
  },
);

export const magazinePatterns = urls(({ path, layout }) => [
  layout(
    (ctx) => {
      const push = ctx.use(Breadcrumbs);
      push({ label: "Magazine", href: ctx.reverse("magazine.index") });
      const meta = ctx.use(Meta);
      meta({ title: { template: "%s | Magazine", default: "Magazine" } });
      return <MagazineLayout />;
    },
    () => [
      path("/", MagazineIndex, { name: "index" }),
      path("/:slug", MagazineArticle, { name: "article" }),
      path("/author/:authorSlug", MagazineAuthor, { name: "author" }),
      path("/author/:authorSlug/posts", MagazineAuthorPosts, {
        name: "author.posts",
      }),
    ],
  ),
]);
