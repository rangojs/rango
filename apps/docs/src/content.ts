import type { ComponentType } from "react";

import { pageMeta, pageTree as generatedTree } from "./content.gen";

export interface TocEntry {
  depth: number;
  text: string;
  id: string;
}

export interface PageMeta {
  url: string;
  slug: string;
  filePath: string;
  title: string;
  description?: string;
  type?: string;
  toc: TocEntry[];
}

export interface TreeNode {
  title: string;
  url?: string;
  children?: TreeNode[];
}

export type MDXContent = ComponentType<{
  components?: Record<string, unknown>;
}>;

export interface DocPage extends PageMeta {
  /** Lazily compiled MDX component (compiled at build time, not route discovery). */
  load: () => Promise<MDXContent>;
}

// Lazy so Rango route discovery never triggers the MDX transform (it can't run it);
// components are pulled in only during the real bundle / at request time.
const loaders = import.meta.glob("/content/docs/**/*.mdx") as Record<
  string,
  () => Promise<{ default: MDXContent }>
>;

export const pages: DocPage[] = pageMeta.map((meta) => ({
  ...meta,
  load: async () => (await loaders[meta.filePath]()).default,
}));

const pagesByUrl = new Map(pages.map((page) => [page.url, page]));

export function getPage(url: string): DocPage | undefined {
  return pagesByUrl.get(url);
}

export const pageTree: TreeNode[] = generatedTree;
