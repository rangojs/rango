/// <reference types="vite/client" />

declare module "@fontsource-variable/open-sans";
declare module "@fontsource-variable/geist-mono";

declare module "*.mdx" {
  import type { ComponentType } from "react";

  const MDXComponent: ComponentType<{ components?: Record<string, unknown> }>;
  export default MDXComponent;
}
