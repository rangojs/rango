import type { DocArticle } from "@shared/docs";

const mdFiles = import.meta.glob("../content/docs/*.md", {
  query: "?raw",
  eager: true,
}) as Record<string, { default: string }>;

function parseFrontmatter(raw: string): {
  meta: Record<string, string>;
  content: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, content: raw };

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    meta[key] = value;
  }
  return { meta, content: match[2].trim() };
}

export const docsArticles: DocArticle[] = Object.entries(mdFiles).map(
  ([filePath, mod]) => {
    const slug = filePath.split("/").pop()!.replace(".md", "");
    const { meta, content } = parseFrontmatter(mod.default);
    return {
      slug,
      title: meta.title ?? slug,
      excerpt: meta.excerpt ?? "",
      content,
    };
  },
);
