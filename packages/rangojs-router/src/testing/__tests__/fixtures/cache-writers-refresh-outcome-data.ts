// A "use cache" function whose answer changes on demand, for
// cache-writers-refresh-outcome.
import { notFound, redirect } from "../../../index.rsc.js";

export const record: {
  outcome: "page" | "notFound" | "redirect" | "error";
  runs: number;
} = { outcome: "page", runs: 0 };

export async function getRecord(): Promise<string> {
  "use cache";
  record.runs += 1;
  if (record.outcome === "notFound") notFound("record deleted");
  if (record.outcome === "redirect") throw redirect("/elsewhere");
  if (record.outcome === "error") throw new Error("upstream down");
  return "record-cached";
}
