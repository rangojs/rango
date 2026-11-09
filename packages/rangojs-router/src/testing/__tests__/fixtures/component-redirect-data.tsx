// The account gate of component-redirect: an async server component that
// redirects a signed-out visitor, alone and inside a "use cache" tree.
import type { ReactElement } from "react";
import { redirect } from "../../../index.rsc.js";

async function AccountGate(): Promise<ReactElement> {
  await Promise.resolve();
  if (!gate.signedIn) throw redirect("/login");
  return <p>summary</p>;
}

export const gate: {
  signedIn: boolean;
  runs: number;
  Component: () => Promise<ReactElement>;
} = { signedIn: false, runs: 0, Component: AccountGate };

/** A cached tree holding the gate: its encode carries the redirect. */
export async function getCachedGate(): Promise<ReactElement> {
  "use cache";
  gate.runs += 1;
  return (
    <section>
      <AccountGate />
    </section>
  );
}
