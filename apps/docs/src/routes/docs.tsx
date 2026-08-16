import { type BuildContext, Meta, notFound, Prerender } from "@rangojs/router";
import { Link, ParallelOutlet } from "@rangojs/router/client";

import { getPage, pages, pageTree, type TreeNode } from "../content";
import { mdxComponents } from "../mdx-components";

// Base for the "Edit this page" link (repo + branch that holds the content).
const GITHUB_EDIT_BASE = "https://github.com/rangojs/rango/blob/main/apps/docs";

// Inline SVG — lucide-react icons resolve to `undefined` in Rango server components.
function EditIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

// Ordered, flat list of navigable pages (tree order) for prev/next pagination.
function flattenTree(nodes: TreeNode[]): { title: string; url: string }[] {
  const out: { title: string; url: string }[] = [];
  for (const node of nodes) {
    if (node.url) out.push({ title: node.title, url: node.url });
    if (node.children) out.push(...flattenTree(node.children));
  }
  return out;
}
const flatNav = flattenTree(pageTree);

async function renderDocsPage(ctx: BuildContext<{ "*"?: string }>) {
  // The `/docs/*` wildcard capture is exposed as ctx.params["*"]; the literal
  // "/docs" route has no params (index page).
  const rest = (ctx.params as Record<string, string | undefined>)["*"] ?? "";
  const url = rest ? `/docs/${rest}` : "/docs";
  const page = getPage(url);
  if (!page) return notFound();

  const meta = ctx.use(Meta);
  meta({ title: `${page.title} — Vercel Shop Docs` });
  if (page.description)
    meta({ content: page.description, name: "description" });

  const Component = await page.load();

  const navIndex = flatNav.findIndex((entry) => entry.url === url);
  const prev = navIndex > 0 ? flatNav[navIndex - 1] : undefined;
  const next =
    navIndex >= 0 && navIndex < flatNav.length - 1
      ? flatNav[navIndex + 1]
      : undefined;

  return (
    <div className="flex w-full gap-10 px-6 py-10">
      <aside className="hidden w-60 shrink-0 lg:block">
        <nav className="sticky top-10 text-sm">
          <ParallelOutlet name="@docsNav" />
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        <article className="prose prose-gray mx-auto w-full max-w-5xl dark:prose-invert">
          <h1 className="mb-2">{page.title}</h1>
          {page.description ? (
            <p className="not-prose mt-0 mb-8 text-lg text-gray-900">
              {page.description}
            </p>
          ) : null}
          <Component components={mdxComponents} />
        </article>

        {prev || next ? (
          <nav className="mx-auto mt-16 flex w-full max-w-5xl items-center gap-4 border-t border-gray-alpha-400 pt-6 text-sm">
            {prev ? (
              <Link
                className="text-gray-900 transition-colors hover:text-gray-1000"
                to={prev.url}
              >
                ← {prev.title}
              </Link>
            ) : null}
            {next ? (
              <Link
                className="ml-auto text-gray-900 transition-colors hover:text-gray-1000"
                to={next.url}
              >
                {next.title} →
              </Link>
            ) : null}
          </nav>
        ) : null}
      </div>

      <aside className="hidden w-56 shrink-0 xl:block">
        <div className="sticky top-10 text-sm">
          {page.toc.length > 0 ? (
            <nav>
              <p className="mb-3 font-medium text-gray-900">On this page</p>
              <ul className="space-y-2">
                {page.toc.map((entry) => (
                  <li
                    key={entry.id}
                    style={{ paddingLeft: (entry.depth - 2) * 12 }}
                  >
                    <a
                      className="text-gray-800 transition-colors hover:text-gray-1000"
                      href={`#${entry.id}`}
                    >
                      {entry.text}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
          <div
            className={
              page.toc.length > 0
                ? "mt-6 border-t border-gray-alpha-400 pt-4"
                : ""
            }
          >
            <a
              className="inline-flex items-center gap-2 text-gray-900 transition-colors hover:text-gray-1000"
              href={`${GITHUB_EDIT_BASE}${page.filePath}`}
              rel="noopener noreferrer"
              target="_blank"
            >
              <EditIcon className="size-3.5 text-gray-700" />
              Edit this page on GitHub
            </a>
          </div>
        </div>
      </aside>
    </div>
  );
}

// Build-time prerendered variants: every docs page is known at build time
// (content.gen.ts enumerates them), so the Flight payloads are computed during
// `vite build` and the render handlers are evicted from the production bundle.
// Runtime PPR shells (the `ppr` route option) sit on top: prerendered segments
// replay during shell capture, and HITs serve the cached HTML directly.
export const DocsIndexPage = Prerender(renderDocsPage);

export const DocsPage = Prerender<{ "*": string }>(
  async () =>
    pages
      .filter((page) => page.slug !== "")
      .map((page) => ({ "*": page.slug })),
  renderDocsPage,
);
