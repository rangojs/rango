"use server";

import { getRequestContext } from "@rangojs/router";
import { LoadMoreNote } from "../location-states.js";

/** Sets LoadMoreNote on the page it runs on. */
export async function noteLoadMore(text: string): Promise<string> {
  getRequestContext().setLocationState(LoadMoreNote({ text }));
  return "done";
}
