import { cookies, createLoader } from "@rangojs/router";

// /loader-cache-identity/* (see urls.tsx), bound with its own cache() (#972).
// The entry is keyed by loader, host, path and params, so without a key()
// the cookies() read throws on the MISS. `stamp` is per run: a repeat is a
// HIT.
export const CachedSessionLoader = createLoader(async () => ({
  session: cookies().get("lci-session")?.value ?? "no-cookie",
  stamp: `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
}));
