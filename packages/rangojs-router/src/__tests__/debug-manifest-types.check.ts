/**
 * Compile-only assertions for the public router.debugManifest() surface.
 *
 * Type-checked by the main tsc pass; never executed (vitest only runs *.test.*,
 * and the body is an unused function). The installed-package path is pinned by
 * public-consumer-imports.test.ts.
 */
import type { Rango, SerializedManifest } from "../index.rsc.js";

export async function _debugManifestPublicTypeChecks(): Promise<void> {
  // The bare public interface, as consumers annotate an exported router.
  const publicRouter = {} as Rango;
  const manifest: SerializedManifest = await publicRouter.debugManifest();

  // @ts-expect-error - totalRoutes is a number; guards against an `any` return
  const wrong: string = manifest.totalRoutes;

  void wrong;
}
