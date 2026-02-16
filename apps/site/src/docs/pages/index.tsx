const quickLinks = [
  {
    title: "Quickstart",
    description: "Get a Rango app running in under five minutes.",
    href: "/docs",
  },
  {
    title: "Routing Guide",
    description: "Learn how urls(), path(), layout(), and include() compose together.",
    href: "/docs/articles",
  },
  {
    title: "Community",
    description: "Join the discussion and contribute on GitHub.",
    href: "https://github.com/nicoyou/rango",
  },
];

export function DocsHomePage() {
  return (
    <article>
      <h1 className="text-4xl font-bold tracking-tight">Documentation</h1>
      <p className="mt-4 text-lg text-gray-300 leading-relaxed">
        Rango is a React framework for the edge with Django-style routing.
        Server Components stream by default, layouts nest naturally, and every
        route is explicit.
      </p>
      <p className="mt-3 text-gray-400 leading-relaxed">
        Browse the guides to learn how routing, caching, and pre-rendering work
        together to keep your app fast without sacrificing developer experience.
      </p>

      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {quickLinks.map((link) => (
          <a
            key={link.title}
            href={link.href}
            className="group rounded-xl border border-white/10 bg-[#151a27] p-5 transition-colors hover:border-[#6ee7b7]/40"
          >
            <h3 className="font-semibold text-white group-hover:text-[#6ee7b7]">
              {link.title}
            </h3>
            <p className="mt-2 text-sm text-gray-400 leading-relaxed">
              {link.description}
            </p>
          </a>
        ))}
      </div>
    </article>
  );
}
