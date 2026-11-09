import { Suspense } from "react";
import { cookies, redirect, urls } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { ComponentRedirectFlash } from "../components/component-redirect.js";
import { ComponentRedirectLogin } from "../components/ComponentRedirectView.js";

// Fixture: an account page whose async server component checks the session
// and throws redirect() for a signed-out visitor, after the handler
// returned. Body: tests/shared-e2e/src/component-redirect-scenario.ts.

const LOGIN = "/component-redirect/login";

async function getSession(): Promise<string | undefined> {
  await new Promise((resolve) => setTimeout(resolve, 30));
  return cookies().get("cr-session")?.value;
}

async function AccountGate() {
  const session = await getSession();
  if (!session) throw redirect(LOGIN);
  return <p data-testid="cr-summary">{`signed in as ${session}`}</p>;
}

async function AccountGateWithState() {
  const session = await getSession();
  if (!session) {
    throw redirect(LOGIN, {
      state: ComponentRedirectFlash({ text: "sign in first" }),
    });
  }
  return <p data-testid="cr-summary">{`signed in as ${session}`}</p>;
}

export const componentRedirectPatterns = urls(({ path }) => [
  path(
    "/component-redirect",
    () => (
      <main data-testid="cr-home">
        <h1>Home</h1>
        <Link to="/component-redirect/account" data-testid="cr-link-account">
          Account
        </Link>
        <Link to="/component-redirect/suspense" data-testid="cr-link-suspense">
          Account behind Suspense
        </Link>
        <Link to="/component-redirect/state" data-testid="cr-link-state">
          Account with a flash
        </Link>
      </main>
    ),
    { name: "componentRedirectHome" },
  ),
  path(LOGIN, () => <ComponentRedirectLogin />, {
    name: "componentRedirectLogin",
  }),
  path(
    "/component-redirect/account",
    () => (
      <main data-testid="cr-account">
        <h1>Account</h1>
        <AccountGate />
      </main>
    ),
    { name: "componentRedirectAccount" },
  ),
  path(
    "/component-redirect/suspense",
    () => (
      <main data-testid="cr-account">
        <h1>Account</h1>
        <Suspense fallback={<p data-testid="cr-pending">checking</p>}>
          <AccountGate />
        </Suspense>
      </main>
    ),
    { name: "componentRedirectSuspense" },
  ),
  path(
    "/component-redirect/state",
    () => (
      <main data-testid="cr-account">
        <h1>Account</h1>
        <AccountGateWithState />
      </main>
    ),
    { name: "componentRedirectState" },
  ),
]);
