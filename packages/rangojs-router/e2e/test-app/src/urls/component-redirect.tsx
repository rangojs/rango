import { redirect, urls } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import type { ReactNode } from "react";

// A server component that throws redirect() (rango-t450).
//
// `redirect()` is a Response, and a component that throws one is only a
// redirect when the throw happens where the request can still answer with one.
// A component that awaits first throws after the Flight shell has flushed, so
// the throw arrives inside the stream instead: the report is that the click
// then shows the error page, while a document request to the same URL lands on
// the target.

/** A session read: always signed out, answered after a tick. */
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
