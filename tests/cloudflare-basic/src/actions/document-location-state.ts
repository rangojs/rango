"use server";

import { getRequestContext, redirect } from "@rangojs/router";
import { DocumentFlash } from "../location-states.js";

/** Post, redirect, get: the flash crosses the 303. */
export async function redirectWithFlash(_form: FormData): Promise<void> {
  throw redirect("/doc-state/target", {
    status: 303,
    state: [DocumentFlash({ text: "paid without js" })],
  });
}

/** Answered with the page itself: the flash rides its document. */
export async function flashInPlace(_form: FormData): Promise<void> {
  getRequestContext().setLocationState(
    DocumentFlash({ text: "saved without js" }),
  );
}
