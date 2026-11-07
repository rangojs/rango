import { Prerender } from "@rangojs/router";

// Loaded with import() so only the build-time prerender evaluates the .mdx
// module, not route discovery (e2e/mdx-imports.test.ts).
export const MdxPrerenderPage = Prerender(async () => {
  const { default: Content } = await import("./mdx-prerender.mdx");
  return (
    <article data-testid="mdx-prerender">
      <Content />
    </article>
  );
});
