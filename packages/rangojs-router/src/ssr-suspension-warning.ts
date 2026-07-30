/**
 * Dev-only diagnostic for the { ssr: false } SSR-completeness opt-in.
 *
 * A document render that awaits flagged loaders before first flush is usually
 * expected to produce an SSR-complete boundary — but the await is scoped per
 * LOADER (see LoaderOptions in types/loader-types.ts), so one unflagged read
 * under the same Suspense boundary still suspends it and the boundary streams
 * as its fallback, invisible without JS. That failure mode looks exactly like
 * the flag not working; a consumer app burned hours on byte-level archaeology
 * before the unflagged sibling read was identified. This warning names the
 * culprit at the suspension site instead.
 *
 * Fires at most once per loader id per process, only during the SSR pass
 * (`window` undefined), only in dev, and only when the render actually awaited
 * flagged loaders (`awaitedLoaderIds` is stamped by segment resolution on the
 * document lane and deliberately NOT during shell capture, where live loaders
 * are masked with never-resolving promises and every read suspends by design).
 */

const warned = new Set<string>();

/** Thenable statuses `use()` unwraps without suspending: React's re-check
 *  after `.then()` handles "fulfilled", and Flight chunks in the resolved_*
 *  states initialize synchronously inside that same call. Anything else
 *  (pending, blocked, an unstamped native promise) suspends at least once. */
function unwrapsSynchronously(stream: Promise<unknown>): boolean {
  const status = (stream as { status?: string }).status;
  return (
    status === "fulfilled" ||
    status === "resolved_model" ||
    status === "resolved_module"
  );
}

export function warnAwaitedSsrSuspension(
  loaderId: string,
  awaitedLoaderIds: readonly string[] | undefined,
  stream: Promise<unknown>,
  isServer: boolean = typeof window === "undefined",
): void {
  if (process.env.NODE_ENV === "production") return;
  if (!isServer) return;
  if (!awaitedLoaderIds || awaitedLoaderIds.length === 0) return;
  if (unwrapsSynchronously(stream)) return;
  if (warned.has(loaderId)) return;
  warned.add(loaderId);

  if (awaitedLoaderIds.includes(loaderId)) {
    console.error(
      `[rango] Loader "${loaderId}" is flagged { ssr: false } and was awaited ` +
        `before first flush, but its useLoader read observed a still-pending ` +
        `promise during SSR. If its Suspense fallback appears in the SSR'd HTML, ` +
        `please report it to @rangojs/router with a reproduction.`,
    );
    return;
  }

  console.warn(
    `[rango] The document render awaited { ssr: false } loader(s) ` +
      `${JSON.stringify(awaitedLoaderIds)} before first flush, but ` +
      `useLoader("${loaderId}") still suspended during SSR. "${loaderId}" is not ` +
      `flagged, so the Suspense boundary above that read streams as its fallback ` +
      `and the content under it stays hidden until JS runs. If the boundary must ` +
      `be SSR-complete, flag "${loaderId}" with { ssr: false } too, or move its ` +
      `read behind its own boundary. If it streams deliberately, ignore this.`,
  );
}
