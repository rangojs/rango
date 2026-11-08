import { redirect, urls } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import type { ReactNode } from "react";

// A `throw redirect()` from a server COMPONENT (mirrors the router e2e app's
// /component-redirect, rango-t450). The throw happens inside the Flight
// render, so a navigation's target rides the error row's digest and the
// router's client boundary replace-navigates; a document request answers a
// real 3xx.
//
// The signed-out session read is a tick, so the "after an await" case throws
// after the shell has flushed: the sync case alone would not pin the
// streaming lane.

async function getSession(): Promise<{ user: string } | null> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  return null;
}

async function AccountGate(): Promise<ReactNode> {
  const session = await getSession();
  if (!session) throw redirect("/component-redirect/login");
  return <p data-testid="cr-summary">account-summary</p>;
}

function AccountPage(): ReactNode {
  return (
    <main data-testid="cr-account">
      <h1>Account</h1>
      <AccountGate />
    </main>
  );
}

function SyncGate(): ReactNode {
  throw redirect("/component-redirect/login");
}

function SyncAccountPage(): ReactNode {
  return (
    <main data-testid="cr-account">
      <h1>Account</h1>
      <SyncGate />
    </main>
  );
}

function IndexPage(): ReactNode {
  return (
    <div data-testid="cr-index">
      <Link to="/component-redirect/after-await" data-testid="cr-link-await">
        account after await
      </Link>
      <Link to="/component-redirect/sync" data-testid="cr-link-sync">
        account sync
      </Link>
    </div>
  );
}

export const componentRedirectPatterns = urls(({ path }) => [
  path("/component-redirect", IndexPage, { name: "componentRedirectIndex" }),
  path("/component-redirect/after-await", AccountPage, {
    name: "componentRedirectAfterAwait",
  }),
  path("/component-redirect/sync", SyncAccountPage, {
    name: "componentRedirectSync",
  }),
  path(
    "/component-redirect/login",
    () => <div data-testid="cr-login">login</div>,
    { name: "componentRedirectLogin" },
  ),
]);
