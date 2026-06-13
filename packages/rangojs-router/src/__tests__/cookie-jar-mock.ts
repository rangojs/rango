/**
 * A minimal document.cookie jar mock for cookie-based unit tests: stores
 * name->value and ignores attributes. Values are token-safe (the version is
 * percent-encoded), so a single `=` split is sufficient. `set`/`del` mutate the
 * jar directly to simulate an external writer.
 */
export interface CookieJarMock {
  /** Stub for `document`: exposes a get/set `cookie` accessor. */
  jar: { cookie: string };
  set: (k: string, v: string) => void;
  del: (k: string) => void;
  store: Record<string, string>;
}

export function makeJar(initial: Record<string, string> = {}): CookieJarMock {
  const store: Record<string, string> = { ...initial };
  const jar = {
    get cookie(): string {
      return Object.entries(store)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    },
    set cookie(str: string) {
      const segment = str.split(";")[0];
      const eq = segment.indexOf("=");
      if (eq < 0) return;
      store[segment.slice(0, eq).trim()] = segment.slice(eq + 1);
    },
  };
  return {
    jar,
    set: (k: string, v: string): void => {
      store[k] = v;
    },
    del: (k: string): void => {
      delete store[k];
    },
    store,
  };
}
