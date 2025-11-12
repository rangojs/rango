/**
 * Example App - SSR Entry Point
 *
 * This file demonstrates using the framework's SSR renderer
 * which handles HTML generation with RSC payload injection.
 */

// Re-export the framework's renderHTML function
// This handles:
// - RSC stream → HTML stream
// - Payload injection for hydration
// - Bootstrap script injection

export { renderHTML } from '../../src/framework/entry.ssr';
