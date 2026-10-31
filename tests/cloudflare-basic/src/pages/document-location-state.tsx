import { redirect, urls } from "@rangojs/router";
import { DocumentFlash } from "../location-states.js";
import {
  DocumentStateBanner,
  DocumentStateForms,
} from "./document-location-state.client.js";

/**
 * Location state on document responses (#1330): a handler's state on the
 * document itself, a handler redirect that carries it to its target, and
 * no-JS form posts (tests/shared-e2e/src/document-location-state-scenario.ts).
 */
export const documentLocationStatePatterns = urls(({ path }) => [
  path(
    "/doc-state",
    () => (
      <>
        <DocumentStateBanner />
        <DocumentStateForms />
      </>
    ),
    { name: "docState" },
  ),
  path("/doc-state/target", () => <DocumentStateBanner />, {
    name: "docStateTarget",
  }),
  // A payment provider sending the shopper back: the handler redirects with
  // the outcome.
  path(
    "/doc-state/callback",
    () =>
      redirect("/doc-state/target", {
        state: [DocumentFlash({ text: "payment declined" })],
      }),
    { name: "docStateCallback" },
  ),
  // An email verification link: the handler sets state on the page itself.
  path(
    "/doc-state/verify",
    (ctx) => {
      ctx.setLocationState(DocumentFlash({ text: "email verified" }));
      return <DocumentStateBanner />;
    },
    { name: "docStateVerify" },
  ),
]);
