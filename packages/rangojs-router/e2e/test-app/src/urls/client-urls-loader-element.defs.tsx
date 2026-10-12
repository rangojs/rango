import type { ReactNode } from "react";
import { createLoader } from "@rangojs/router";
import { ClientUrlsElementBadge } from "./client-urls-loader-element.badge.js";

// A loader whose answer draws a client component
// (client-urls-loader-element.test.ts).
export const ClientUrlsElementLoader = createLoader(
  async (): Promise<{ badge: ReactNode }> => ({
    badge: <ClientUrlsElementBadge label="badge from the loader" />,
  }),
);
