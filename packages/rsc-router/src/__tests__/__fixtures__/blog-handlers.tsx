/**
 * Blog handlers - Should ONLY load when /blog routes are accessed
 * Tracks loading via global flag
 */

import { route, map } from '../../route-definition';

// TRACKING: Set flag when this module loads
if (typeof globalThis !== 'undefined') {
  (globalThis as any).__blogHandlersLoaded = true;
}

export const blogRoutes = route({
  index: '/blog',
  post: '/blog/:slug',
});

export default map(blogRoutes, {
  [route.layout]: () => <div>BlogLayout</div>,
  index: () => <div>BlogIndex</div>,
  post: (ctx) => <div>BlogPost: {ctx.params.slug}</div>,
});
