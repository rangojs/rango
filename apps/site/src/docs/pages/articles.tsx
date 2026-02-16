const articles = [
  {
    title: "Understanding Route Composition",
    summary: "How urls(), path(), layout(), and include() work together to build type-safe route trees.",
  },
  {
    title: "Segment Caching Deep Dive",
    summary: "Per-segment TTL and stale-while-revalidate policies for fine-grained cache control.",
  },
  {
    title: "Pre-rendering at Build Time",
    summary: "Use Prerender to generate static Flight payloads at build time while keeping the worker in the loop.",
  },
  {
    title: "Streaming with Suspense",
    summary: "How loaders and async components stream progressively to the browser.",
  },
];

export function DocsArticlesPage() {
  return (
    <article>
      <h1 className="text-4xl font-bold tracking-tight">Articles</h1>
      <p className="mt-4 text-lg text-gray-300 leading-relaxed">
        In-depth guides and walkthroughs covering Rango's core concepts.
      </p>

      <ul className="mt-10 divide-y divide-white/10">
        {articles.map((article) => (
          <li key={article.title} className="py-5">
            <h3 className="font-semibold text-white">{article.title}</h3>
            <p className="mt-1 text-sm text-gray-400 leading-relaxed">
              {article.summary}
            </p>
          </li>
        ))}
      </ul>
    </article>
  );
}
