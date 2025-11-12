/**
 * AsyncLocalStorage for coordinating streams between environments
 *
 * This is used to pass stream references from RSC environment to SSR environment
 * when using vite-plugin-rsc's multi-environment architecture.
 */

import { AsyncLocalStorage } from 'async_hooks';

/**
 * Storage for passing streams between RSC and SSR environments
 */
export const Storage = new AsyncLocalStorage<ReadableStream<Uint8Array>[]>();
