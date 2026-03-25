/**
 * Mutable app version — updated after HMR revalidation.
 * Read by prefetch, navigation, and context code.
 */

let currentVersion: string | undefined;

export function getAppVersion(): string | undefined {
  return currentVersion;
}

export function setAppVersion(version: string | undefined): void {
  currentVersion = version;
}
