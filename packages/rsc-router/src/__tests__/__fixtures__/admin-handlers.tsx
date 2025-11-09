/**
 * Admin handlers - Should ONLY load when /admin routes are accessed
 * Tracks loading via global flag
 */

import { route, map } from '../../route-definition';

// TRACKING: Set flag when this module loads
if (typeof globalThis !== 'undefined') {
  (globalThis as any).__adminHandlersLoaded = true;
}

export const adminRoutes = route({
  dashboard: '/admin',
  users: '/admin/users',
});

export default map(adminRoutes, {
  [route.layout]: () => <div>AdminLayout</div>,
  dashboard: () => <div>Dashboard</div>,
  users: () => <div>Users</div>,
});
