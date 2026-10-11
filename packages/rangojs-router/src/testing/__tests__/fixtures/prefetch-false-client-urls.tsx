"use client";

/**
 * Stands for a clientUrls() definition module. On the server the default
 * export of a "use client" module is a client reference
 * (rangoUseClientTransform), which is what include() receives in an app and
 * what ClientUrlsRoot is handed as its `definition`. The test installs the
 * definition's projection under it, as discovery does
 * (vite/discovery/client-urls-projection.ts).
 */
export default function PrefetchFalseClientUrls(): null {
  return null;
}
