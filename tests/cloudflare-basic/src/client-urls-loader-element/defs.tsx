import type { ReactNode } from "react";
import { createLoader } from "@rangojs/router";
import { ClientUrlsElementBadge } from "./badge.js";

// A loader whose answer draws a client component
// (e2e/client-urls-loader-element.test.ts).
export const ClientUrlsElementLoader = createLoader(
  async (): Promise<{ badge: ReactNode }> => ({
    badge: <ClientUrlsElementBadge label="badge from the loader" />,
  }),
);
