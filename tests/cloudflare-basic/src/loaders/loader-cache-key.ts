import { createLoader } from "@rangojs/router";

// /test/loader-key-* (issue #1009; see urls.tsx). Each binds its own cache()
// on the app's CFCacheStore: the victim with the default key, the crafted one
// with a key() that returns a request header as is. `stamp` is per run: a
// repeat is a HIT.
export const LoaderKeyVictimLoader = createLoader(async () => ({
  from: "victim",
  stamp: crypto.randomUUID(),
}));

export const LoaderKeyCraftedLoader = createLoader(async () => ({
  from: "crafted",
  stamp: crypto.randomUUID(),
}));
