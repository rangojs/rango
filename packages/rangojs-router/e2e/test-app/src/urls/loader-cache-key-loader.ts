import { createLoader } from "@rangojs/router";

// /cache-test/loader-key-* (issue #1009; see urls/cache.tsx). Each binds its
// own cache(): the victim with the default key, the crafted one with a key()
// that returns a request header as is. `stamp` is per run: a repeat is a HIT.
export const LoaderKeyVictimLoader = createLoader(async () => ({
  from: "victim",
  stamp: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
}));

export const LoaderKeyCraftedLoader = createLoader(async () => ({
  from: "crafted",
  stamp: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
}));
