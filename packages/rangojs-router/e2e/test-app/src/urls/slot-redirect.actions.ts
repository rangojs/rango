"use server";

import { cookies } from "@rangojs/router";

/** Arms the slot-redirect handlers: each redirects once this cookie is set. */
export async function armSlotRedirect(): Promise<string> {
  cookies().set("sr-armed", "1", { path: "/" });
  return "armed";
}
