/**
 * Example App - RSC Entry Point
 *
 * This file demonstrates using the framework's createRSCHandler
 * with a fully configured router.
 */

import { createRSCHandler } from '../../src/framework/entry.rsc';
import router from './server';

// That's it! The framework handles everything:
// - Full vs partial rendering
// - Server actions
// - Segment metadata
// - RSC stream generation

export default createRSCHandler(router);
