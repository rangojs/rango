import { Feed } from "feed";

import { docsDescription, docsTitle, getBaseUrl, siteName } from "@/lib/site";

import { pages } from "../content";

function base(): string {
  return getBaseUrl().toString().replace(/\/$/, "");
}

/** llms.txt — the llmstxt.org index of documentation pages. */
export function llms(): string {
  const lines = [
    `# ${docsTitle}`,
    "",
    `> ${docsDescription}`,
    "",
    "## Docs",
    "",
  ];
  for (const page of pages) {
    lines.push(
      `- [${page.title}](${base()}${page.url})${page.description ? `: ${page.description}` : ""}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function robots(): string {
  return [
    "User-agent: *",
    "Allow: /",
    `Sitemap: ${base()}/sitemap.xml`,
    "",
  ].join("\n");
}

export function sitemap(): string {
  const urls = [`${base()}/`, ...pages.map((page) => `${base()}${page.url}`)];
  const entries = urls
    .map((url) => `  <url><loc>${url}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
}

export function rss(): Response {
  const b = base();
  const feed = new Feed({
    copyright: `All rights reserved ${new Date().getFullYear()}, Vercel`,
    id: b,
    link: b,
    title: docsTitle,
  });
  for (const page of pages) {
    feed.addItem({
      author: [{ name: "Vercel" }],
      date: new Date(),
      description: page.description,
      id: page.url,
      link: `${b}${page.url}`,
      title: page.title,
    });
  }
  return new Response(feed.rss2(), {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
}

/** agents.md — agent-readability index (product + documentation pages). */
export function agents(): string {
  const lines = [
    `# ${siteName}`,
    "",
    `> ${docsDescription}`,
    "",
    "## Documentation",
    "",
  ];
  for (const page of pages) {
    lines.push(
      `- [${page.title}](${base()}${page.url})${page.description ? ` — ${page.description}` : ""}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function mcp(): Record<string, unknown> {
  return {
    description: docsDescription,
    docs: `${base()}/docs`,
    name: siteName,
    pages: pages.map((page) => ({
      description: page.description,
      title: page.title,
      url: `${base()}${page.url}`,
    })),
  };
}
