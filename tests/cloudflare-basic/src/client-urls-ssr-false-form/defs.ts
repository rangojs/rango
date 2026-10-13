import { createLoader } from "@rangojs/router";

// The page loader of urls.tsx, flagged ssr: false there
// (e2e/client-urls-ssr-false-form.test.ts).
export const SsrFalseFormLoader = createLoader(
  async (): Promise<{ id: string }> => ({ id: "item-1" }),
);
