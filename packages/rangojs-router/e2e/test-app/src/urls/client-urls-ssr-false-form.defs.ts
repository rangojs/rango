import { createLoader } from "@rangojs/router";

// The page loader of client-urls-ssr-false-form.tsx, flagged ssr: false
// there (client-urls-ssr-false-form.test.ts).
export const SsrFalseFormLoader = createLoader(
  async (): Promise<{ id: string }> => ({ id: "item-1" }),
);
