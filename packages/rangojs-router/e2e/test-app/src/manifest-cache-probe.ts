/**
 * Manifest cache probe — tracks how many times the DSL handler runs.
 *
 * The DSL handler (the function passed to urls()) executes inside loadManifest().
 * After the first call, the manifest is cached at module level, so the handler
 * should not run again within the same isolate.
 *
 * This counter is incremented by the urls() callback in manifest-cache-probe-urls.tsx
 * and read by the /__test/manifest-cache-counter JSON endpoint.
 */
export let handlerExecutions = 0;

export function incrementHandlerExecutions(): void {
  handlerExecutions++;
}
