/**
 * Example App - Browser Entry Point
 *
 * This file demonstrates using the framework's browser entry
 * which provides automatic SPA navigation and segment management.
 */

// Just import the framework entry - it auto-initializes!
// This gives you:
// - Hydration from SSR
// - SPA navigation (link interception)
// - Partial rendering
// - Segment management
// - Browser history integration

import '../../src/framework/entry.browser';

console.log('✓ Example app initialized with RSC Router framework');
console.log('✓ SPA navigation enabled');
console.log('✓ Partial rendering active');
