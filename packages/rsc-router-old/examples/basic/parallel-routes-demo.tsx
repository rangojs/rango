/**
 * Example: Parallel Routes Demonstration
 *
 * This file explicitly demonstrates how parallel routes work:
 * PARALLEL ROUTES ARE ADDITIVE - they render ALONGSIDE main content
 */

import { route } from '../../src/route-definition';
import { buildSegmentMap } from '../../src/segment-system';
import { reconstructTreeFromSegments } from '../../src/client';

// ============================================================================
// COMPONENTS
// ============================================================================

const DashboardMain = () => (
  <main>
    <h1>Dashboard Main Content</h1>
    <p>This is the main dashboard content.</p>
  </main>
);

const Sidebar = () => (
  <aside>
    <h2>Sidebar</h2>
    <nav>
      <ul>
        <li>Link 1</li>
        <li>Link 2</li>
      </ul>
    </nav>
  </aside>
);

const NotificationPanel = () => (
  <div className="notifications">
    <h3>Notifications</h3>
    <ul>
      <li>Notification 1</li>
      <li>Notification 2</li>
    </ul>
  </div>
);

const Modal = () => (
  <div className="modal">
    <h3>Modal Dialog</h3>
    <p>Modal content</p>
  </div>
);

// ============================================================================
// EXAMPLE 1: Basic Parallel Routes
// ============================================================================

console.log('\n' + '='.repeat(70));
console.log('EXAMPLE 1: Basic Parallel Routes');
console.log('='.repeat(70));

const example1Handlers = {
  index: () => <DashboardMain />,
  [route.parallel]: {
    '@sidebar': () => <Sidebar />,
    '@notifications': () => <NotificationPanel />,
  },
};

const example1Match = {
  pathname: '/dashboard',
  params: {},
  handlers: example1Handlers,
};

const example1Segments = buildSegmentMap(example1Match);

console.log('\n📊 Segment Map:');
example1Segments.forEach((seg) => {
  console.log(`   ${seg.id}: ${seg.type}${seg.slot ? ` (${seg.slot})` : ''}`);
});

console.log('\n🎨 Rendering Structure:');
console.log('   <>');
console.log('     <DashboardMain />      // Main route content (R0)');
console.log('     <Sidebar />            // @sidebar parallel (P1)');
console.log('     <NotificationPanel />  // @notifications parallel (P2)');
console.log('   </>');

console.log('\n✅ Result: ALL THREE components render together!');

// ============================================================================
// EXAMPLE 2: Per-Route Parallel Routes Override
// ============================================================================

console.log('\n' + '='.repeat(70));
console.log('EXAMPLE 2: Per-Route Override (Same Slot Name)');
console.log('='.repeat(70));

const example2Handlers = {
  [route.parallel]: {
    '@sidebar': () => <div>Global Sidebar</div>,
  },
  dashboard: {
    [route.parallel]: {
      '@sidebar': () => <Sidebar />, // Same slot name - OVERRIDES
    },
    handler: () => <DashboardMain />,
  },
};

console.log('\n📋 Configuration:');
console.log('   Global: @sidebar → GlobalSidebar');
console.log('   Dashboard: @sidebar → DashboardSidebar');

console.log('\n🎨 Rendering (on /dashboard):');
console.log('   <>');
console.log('     <DashboardMain />      // Main route');
console.log('     <Sidebar />            // DashboardSidebar (per-route OVERRIDES global)');
console.log('   </>');

console.log('\n✅ Result: Per-route @sidebar replaces global @sidebar');

// ============================================================================
// EXAMPLE 3: Merging Global and Per-Route (Different Slots)
// ============================================================================

console.log('\n' + '='.repeat(70));
console.log('EXAMPLE 3: Merging Global + Per-Route (Different Slot Names)');
console.log('='.repeat(70));

const example3Handlers = {
  [route.parallel]: {
    '@sidebar': () => <Sidebar />, // Global slot
  },
  dashboard: {
    [route.parallel]: {
      '@notifications': () => <NotificationPanel />, // Different slot name
      '@modal': () => <Modal />, // Another different slot
    },
    handler: () => <DashboardMain />,
  },
};

console.log('\n📋 Configuration:');
console.log('   Global: @sidebar');
console.log('   Dashboard: @notifications, @modal');

console.log('\n🎨 Rendering (on /dashboard):');
console.log('   <>');
console.log('     <DashboardMain />      // Main route');
console.log('     <Sidebar />            // From GLOBAL (different name)');
console.log('     <NotificationPanel />  // From PER-ROUTE (different name)');
console.log('     <Modal />              // From PER-ROUTE (different name)');
console.log('   </>');

console.log('\n✅ Result: ALL FOUR components render (global + per-route merged)');

// ============================================================================
// EXAMPLE 4: Parallel Routes with Layouts
// ============================================================================

console.log('\n' + '='.repeat(70));
console.log('EXAMPLE 4: Parallel Routes with Nested Layouts');
console.log('='.repeat(70));

const RootLayout = () => <html><body>Root</body></html>;
const DashboardLayoutComponent = () => <div className="dashboard">Dashboard Layout</div>;

const example4Handlers = {
  [route.layout]: [RootLayout, DashboardLayoutComponent],
  index: () => <DashboardMain />,
  [route.parallel]: {
    '@sidebar': () => <Sidebar />,
    '@notifications': () => <NotificationPanel />,
  },
};

const example4Match = {
  pathname: '/dashboard',
  params: {},
  handlers: example4Handlers,
};

const example4Segments = buildSegmentMap(example4Match);

console.log('\n📊 Segment Map:');
example4Segments.forEach((seg) => {
  console.log(`   ${seg.id}: ${seg.type}${seg.slot ? ` (${seg.slot})` : ''}`);
});

console.log('\n🎨 Rendering Structure:');
console.log('   <RootLayout>              // L0 (outermost)');
console.log('     <DashboardLayout>       // L1');
console.log('       <>');
console.log('         <DashboardMain />   // R2 (main route)');
console.log('         <Sidebar />         // P3 (@sidebar)');
console.log('         <NotificationPanel /> // P4 (@notifications)');
console.log('       </>');
console.log('     </DashboardLayout>');
console.log('   </RootLayout>');

console.log('\n✅ Result: Layouts wrap the combined content (route + parallel routes)');

console.log('\n' + '='.repeat(70));
console.log('KEY TAKEAWAY: Parallel routes are SIBLINGS of the main route');
console.log('='.repeat(70));
