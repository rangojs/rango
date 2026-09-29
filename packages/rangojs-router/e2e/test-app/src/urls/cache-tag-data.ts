import { cacheTag } from "@rangojs/router";

// "use cache" function tagged at runtime. The cached value (incl. its ts) is
// reused until one of its tags is invalidated. Shared by the /cache-tag-test
// routes and the revalidate-then-read action so both read the same entry.
export async function getTaggedItem(
  id: string,
): Promise<{ ts: number; id: string }> {
  "use cache";
  cacheTag("items", `item:${id}`);
  return { ts: Date.now(), id };
}
