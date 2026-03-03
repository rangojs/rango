"use server";

import { getRequestContext } from "@rangojs/router";
import { ActionFlash } from "../location-states.js";

export async function setLocationStateAction(): Promise<string> {
  const ctx = getRequestContext();
  ctx.setLocationState([ActionFlash({ message: "saved-from-action" })]);
  return "ok";
}
