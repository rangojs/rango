"use client";

/**
 * Components that carry their own clientUrls() items, the server handler.use
 * pattern, in a module apart from the group
 * (client-urls-component-use.tsx), with the helpers @rangojs/router/client
 * exports (imported from their module here: this package's own sources).
 * Exported through annotated consts: isolatedDeclarations rejects an exported
 * function with an assigned property.
 */
import {
  loader,
  loading,
  revalidate,
} from "../../../client-urls/client-urls.js";
import type { ClientUrlComponent } from "../../../client-urls/types.js";
import {
  CartLoader,
  StatsLoader,
  bumpStats,
} from "./client-urls-component-use-data.js";

function DashboardPage(): null {
  return null;
}
DashboardPage.use = () => [
  loader(StatsLoader, () => [
    revalidate(({ isAction }) => isAction(bumpStats)),
  ]),
  loading(<p>dashboard-skeleton</p>),
];

function ShellLayout(): null {
  return null;
}
ShellLayout.use = () => [loader(CartLoader)];

export const Dashboard: ClientUrlComponent = DashboardPage;
export const Shell: ClientUrlComponent = ShellLayout;
