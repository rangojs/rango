// Main entry point for rsc-router
export * from './types';
export * from './router';
export * from './segments';
export * from './matcher';
export * from './route-definition';
export * from './create-router';
export * from './linear-matcher';

// Export segment-system utilities but not Segment/SegmentType (already exported from types.ts)
export {
  generateSegmentId,
  parseSegmentId,
  isValidSegmentId,
  createSegment,
  parseClientSegments,
  computeDifferential,
  buildSegmentMap,
  renderSegments,
} from './segment-system';

// Re-export client components (Vite traces "use client" back to source files)
export { Link } from './Link';
export type { LinkProps } from './Link';
export { Outlet, OutletProvider, useOutlet } from './Outlet';

// Re-export client-side utilities
export {
  SegmentStore,
  navigateToRoute,
  processPayload,
  reconstructTreeFromSegments,
} from './client';
export type { NavigationOptions } from './client';
