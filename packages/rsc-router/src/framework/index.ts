/**
 * RSC Router Framework - Out-of-the-Box Integration
 *
 * Import these in your Vite entry points for production-ready RSC support.
 */

// Types
export type { RscPayload } from './types';

// Server entry helper
export { createRSCHandler } from './entry.rsc';

// SSR entry
export { renderHTML } from './entry.ssr';

// Browser entry (import for side effects - auto-initializes)
// import 'rsc-router/framework/entry.browser';
