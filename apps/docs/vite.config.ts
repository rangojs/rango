import { readFile } from "node:fs/promises";

import { cloudflare } from "@cloudflare/vite-plugin";
import mdx from "@mdx-js/rollup";
import { rango } from "@rangojs/router/vite";
import rehypeShiki from "@shikijs/rehype";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSlug from "rehype-slug";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import { defineConfig, type Plugin } from "vite";

/**
 * MDX as a `load` hook instead of `transform`. Rango's prerender/discovery
 * temp server forwards user plugins stripped to their resolution hooks
 * (resolveId/load) only, so a transform-based MDX plugin never runs there and
 * build-time prerendering of MDX-backed pages fails on raw markdown. Loading
 * (read + compile) keeps MDX working in dev, build, AND the prerender runner.
 * Compilation is delegated to @mdx-js/rollup's own transform so options and
 * dev-mode detection stay identical.
 */
function mdxLoad(options: Parameters<typeof mdx>[0]): Plugin {
  const base = mdx(options);
  return {
    name: "mdx-load",
    enforce: "pre",
    config: base.config,
    async load(id) {
      const [path] = id.split("?");
      if (!path.endsWith(".mdx")) return;
      const value = await readFile(path, "utf8");
      return base.transform.call(this, value, id);
    },
  };
}

export default defineConfig({
  resolve: {
    alias: { "@": import.meta.dirname },
  },
  plugins: [
    // MDX must compile .mdx -> JS before react/rango see the modules.
    mdxLoad({
      remarkPlugins: [remarkFrontmatter, remarkGfm],
      rehypePlugins: [
        rehypeSlug,
        [rehypeAutolinkHeadings, { behavior: "wrap" }],
        [
          rehypeShiki,
          { themes: { dark: "github-dark", light: "github-light" } },
        ],
      ],
    }),
    react(),
    rango({ preset: "cloudflare" }),
    cloudflare({
      configPath: "./wrangler.json",
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
    tailwindcss(),
  ],
});
